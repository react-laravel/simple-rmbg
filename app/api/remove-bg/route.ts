import { NextRequest, NextResponse } from 'next/server'
import {
  DEFAULT_MODEL_WEIGHT,
  getModelRuntimeInfo,
  isModelWeight,
  removeBackground,
  type BackgroundOption,
  type ModelWeight,
} from '@/lib/bg-removal'

export const runtime = 'nodejs'
export const maxDuration = 600

const MAX_BYTES = 15 * 1024 * 1024 // 15MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

function normalizeBg(value: string | null | undefined): BackgroundOption {
  if (!value || value === 'transparent') return 'transparent'
  if (value === 'white') return '#ffffff'
  if (value === 'black') return '#000000'
  return value
}

function normalizeWeight(value: string | null | undefined): ModelWeight {
  if (!value) return DEFAULT_MODEL_WEIGHT
  if (isModelWeight(value)) return value
  throw new Error(`不支持的权重: ${value}，可选 q4 或 fp32`)
}

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

function formatServerError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err)
  const lower = base.toLowerCase()
  if (
    lower.includes('unauthorized') ||
    lower.includes('401') ||
    (base.includes('RMBG-2.0') &&
      (lower.includes('fetch failed') || lower.includes('connect timeout')))
  ) {
    return `${base}。RMBG-2.0 为受条款保护模型：1) 在 https://huggingface.co/briaai/RMBG-2.0 登录并同意条款；2) 创建 Access Token，启动时设置 HF_TOKEN=hf_...；或 3) 在本机下载 models/RMBG-2.0（含 onnx/model_q4.onnx 和 onnx/model.onnx）上传到服务器，设置 MODEL_LOCAL_ONLY=true。部署时 models/ 不会随 git 提交。`
  }
  if (lower.includes('fetch failed') || lower.includes('connect timeout')) {
    return `${base}。模型首次下载失败，请检查网络/代理，或先手动下载模型到本地模型目录后重试。`
  }
  return base
}

/** 健康检查；可用 ?weight=q4|fp32 检查对应本地权重。 */
export async function GET(req: NextRequest) {
  try {
    const weight = normalizeWeight(new URL(req.url).searchParams.get('weight'))
    const runtime = getModelRuntimeInfo(weight)
    return NextResponse.json(
      {
        status: runtime.onnxModelExists ? 'ready' : 'error',
        model: runtime.modelId,
        runtime,
      },
      { status: runtime.onnxModelExists ? 200 : 503 }
    )
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err))
  }
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url)
  const contentType = req.headers.get('content-type') ?? ''

  let bytes: Uint8Array
  let bg: BackgroundOption = 'transparent'
  let weight: ModelWeight = DEFAULT_MODEL_WEIGHT
  let format = url.searchParams.get('format') ?? 'png'

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData()
      const file = form.get('image')
      if (!(file instanceof File)) {
        return errorResponse('缺少 image 文件字段')
      }
      if (file.type && !ALLOWED_TYPES.includes(file.type)) {
        return errorResponse(`不支持的文件类型: ${file.type}，仅支持 jpeg/png/webp`)
      }
      if (file.size > MAX_BYTES) {
        return errorResponse('图片过大，最大 15MB', 413)
      }
      bytes = new Uint8Array(await file.arrayBuffer())
      bg = normalizeBg((form.get('bg') as string) ?? url.searchParams.get('bg'))
      const formWeight = form.get('weight')
      weight = normalizeWeight(
        typeof formWeight === 'string' ? formWeight : url.searchParams.get('weight')
      )
      format = (form.get('format') as string) ?? format
    } else if (contentType.includes('application/json')) {
      const body = (await req.json()) as {
        image_url?: string
        bg?: string
        format?: string
        weight?: string
      }
      if (!body.image_url) {
        return errorResponse('缺少 image_url 字段')
      }
      const res = await fetch(body.image_url)
      if (!res.ok) {
        return errorResponse(`无法获取 image_url: HTTP ${res.status}`)
      }
      const buf = await res.arrayBuffer()
      if (buf.byteLength > MAX_BYTES) {
        return errorResponse('图片过大，最大 15MB', 413)
      }
      bytes = new Uint8Array(buf)
      bg = normalizeBg(body.bg ?? url.searchParams.get('bg'))
      weight = normalizeWeight(body.weight ?? url.searchParams.get('weight'))
      format = body.format ?? format
    } else {
      const buf = await req.arrayBuffer()
      if (buf.byteLength === 0) {
        return errorResponse('请求体为空，请上传图片')
      }
      if (buf.byteLength > MAX_BYTES) {
        return errorResponse('图片过大，最大 15MB', 413)
      }
      bytes = new Uint8Array(buf)
      bg = normalizeBg(url.searchParams.get('bg'))
      weight = normalizeWeight(url.searchParams.get('weight'))
    }
  } catch (err) {
    return errorResponse(`请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    const { png, width, height } = await removeBackground(bytes, { bg, weight })

    if (format === 'json') {
      return NextResponse.json({
        width,
        height,
        format: 'png',
        data: `data:image/png;base64,${png.toString('base64')}`,
      })
    }

    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(png.length),
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return errorResponse(`处理失败: ${formatServerError(err)}`, 500)
  }
}
