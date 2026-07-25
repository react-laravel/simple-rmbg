import path from 'path'
import fs from 'fs'
import {
  env,
  AutoModelForImageSegmentation,
  AutoProcessor,
  type PreTrainedModel,
} from '@huggingface/transformers'
import { ProxyAgent, setGlobalDispatcher } from 'undici'
import type { ModelWeight } from './types'
import { getErrorMessage, isRetryableNetworkError, sleep } from './utils'

// 模型与处理器按请求选择权重；大模型每次推理后会释放 ONNX session。
env.cacheDir = path.join(process.cwd(), '.cache')

function normalizeRemoteHost(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

export const remoteHosts = Array.from(
  new Set(
    [
      process.env.HF_ENDPOINT,
      process.env.MODEL_REMOTE_HOST,
      'https://hf-mirror.com/',
      'https://huggingface.co/',
    ]
      .filter((v): v is string => Boolean(v))
      .map(normalizeRemoteHost)
  )
)

env.remoteHost = remoteHosts[0] ?? env.remoteHost

const proxyUrl = process.env.MODEL_PROXY_URL ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl))
}

const MODEL_LOCAL_ONLY = ['1', 'true', 'yes', 'on'].includes(
  (process.env.MODEL_LOCAL_ONLY ?? '').toLowerCase()
)

export const DEFAULT_MODEL_WEIGHT: ModelWeight = 'q4'
export const MODEL_WEIGHTS: ModelWeight[] = ['q4', 'fp32']

type Processor = Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>

type ModelSpec = {
  id: string
  localPath: string
  displayName: string
  modelType: 'birefnet'
  weight: ModelWeight
  dtype: 'q4' | 'fp32'
  onnxFilename: 'model_q4.onnx' | 'model.onnx'
  processorConfig: {
    do_normalize: boolean
    do_pad: boolean
    do_rescale: boolean
    do_resize: boolean
    image_mean: number[]
    image_std: number[]
    resample: number
    rescale_factor: number
    size: { width: number; height: number }
  }
}

export const MODEL_LOCAL_PATH = path.resolve(
  process.env.MODEL_2_0_LOCAL_PATH ??
    process.env.MODEL_LOCAL_PATH ??
    path.join(process.cwd(), 'models', 'RMBG-2.0')
)

function getModelSpec(weight: ModelWeight): ModelSpec {
  return {
    id: 'briaai/RMBG-2.0',
    displayName: `RMBG-2.0 ${weight.toUpperCase()}`,
    localPath: MODEL_LOCAL_PATH,
    modelType: 'birefnet',
    weight,
    dtype: weight,
    onnxFilename: weight === 'q4' ? 'model_q4.onnx' : 'model.onnx',
    processorConfig: {
      do_normalize: true,
      do_pad: false,
      do_rescale: true,
      do_resize: true,
      image_mean: [0.485, 0.456, 0.406],
      image_std: [0.229, 0.224, 0.225],
      resample: 2,
      rescale_factor: 1 / 255,
      size: { width: 1024, height: 1024 },
    },
  }
}

function getOnnxModelPath(spec: ModelSpec) {
  return path.join(spec.localPath, 'onnx', spec.onnxFilename)
}

let modelPromise: Promise<{ model: PreTrainedModel; processor: Processor; spec: ModelSpec }> | null =
  null
let activeWeight: ModelWeight | null = null

async function loadModelFrom(source: string, localFilesOnly: boolean, spec: ModelSpec) {
  const modelOptions = {
    config: { model_type: spec.modelType } as never,
    dtype: spec.dtype,
    local_files_only: localFilesOnly,
  }
  const model = await AutoModelForImageSegmentation.from_pretrained(source, modelOptions)
  const processor = await AutoProcessor.from_pretrained(source, {
    config: spec.processorConfig as never,
    local_files_only: localFilesOnly,
  })
  return { model, processor, spec }
}

function assertLocalModelReady(spec: ModelSpec) {
  const onnxModelPath = getOnnxModelPath(spec)
  if (!fs.existsSync(onnxModelPath)) {
    throw new Error(
      `本地 ${spec.weight} 权重不完整，缺少 ${onnxModelPath}。请上传该权重，或配置 HF_TOKEN 从 Hugging Face 拉取。`
    )
  }
}

async function loadModelWithRetry(weight: ModelWeight, maxAttempts = 4) {
  const spec = getModelSpec(weight)
  const onnxModelPath = getOnnxModelPath(spec)
  const hasOnnxModel = fs.existsSync(onnxModelPath)
  if (hasOnnxModel) {
    try {
      return await loadModelFrom(spec.localPath, true, spec)
    } catch (err) {
      if (MODEL_LOCAL_ONLY) {
        throw new Error(`[local_only path=${spec.localPath}] ${getErrorMessage(err)}`)
      }
    }
  } else if (MODEL_LOCAL_ONLY) {
    assertLocalModelReady(spec)
  }

  let lastError: unknown = null
  for (const host of remoteHosts) {
    env.remoteHost = host
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await loadModelFrom(spec.id, false, spec)
      } catch (err) {
        lastError = new Error(`[host=${host}] ${getErrorMessage(err)}`)
        if (attempt === maxAttempts || !isRetryableNetworkError(err)) {
          break
        }
        await sleep(2 ** attempt * 1000)
      }
    }
  }
  throw lastError
}

export function isModelWeight(value: unknown): value is ModelWeight {
  return typeof value === 'string' && MODEL_WEIGHTS.includes(value as ModelWeight)
}

export function getModel(weight: ModelWeight = DEFAULT_MODEL_WEIGHT) {
  if (modelPromise && activeWeight !== weight) {
    throw new Error(`模型正在使用 ${activeWeight} 权重，请稍后重试 ${weight}`)
  }
  if (!modelPromise) {
    const spec = getModelSpec(weight)
    activeWeight = weight
    modelPromise = loadModelWithRetry(weight).catch((err) => {
      modelPromise = null
      activeWeight = null
      throw new Error(
        `${spec.displayName} 模型加载失败: ${getErrorMessage(err)}。可将模型放到 ${spec.localPath} 并设置 MODEL_LOCAL_ONLY=true`
      )
    })
  }
  return modelPromise
}

/** 释放 ONNX session 及其内存池；大模型在本机每次推理后必须回收。 */
export async function unloadModel() {
  const current = modelPromise
  modelPromise = null
  activeWeight = null
  if (!current) return
  try {
    const { model } = await current
    await model.dispose()
  } catch {
    // 加载失败时 getModel() 已负责清空缓存；这里无需覆盖原始错误。
  }
}

export function getModelRuntimeInfo(weight: ModelWeight = DEFAULT_MODEL_WEIGHT) {
  const spec = getModelSpec(weight)
  const onnxModelPath = getOnnxModelPath(spec)
  const hasHfToken = Boolean(process.env.HF_TOKEN?.trim())
  const availableWeights = MODEL_WEIGHTS.filter((candidate) =>
    fs.existsSync(getOnnxModelPath(getModelSpec(candidate)))
  )
  return {
    modelId: spec.id,
    modelWeight: spec.weight,
    defaultWeight: DEFAULT_MODEL_WEIGHT,
    availableWeights,
    localPath: spec.localPath,
    onnxModelPath,
    localPathExists: fs.existsSync(spec.localPath),
    onnxModelExists: fs.existsSync(onnxModelPath),
    localOnly: MODEL_LOCAL_ONLY,
    hasHfToken,
    remoteHosts,
    currentRemoteHost: env.remoteHost,
    setupHint: fs.existsSync(onnxModelPath)
      ? `本地 ${spec.weight} 权重已就绪`
      : hasHfToken
        ? '将使用 HF_TOKEN 从 Hugging Face 下载（需已接受 briaai/RMBG-2.0 条款）'
        : `缺少 ${spec.onnxFilename}，请上传对应权重或配置 HF_TOKEN`,
  }
}
