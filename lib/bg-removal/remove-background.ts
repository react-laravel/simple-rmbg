import { RawImage, type PreTrainedModel } from '@huggingface/transformers'
import sharp from 'sharp'
import { getModel } from './model-loader'
import { getPrimaryOutputTensor } from './model-output'
import type { RemoveBackgroundOptions, RemoveBackgroundResult } from './types'

type LoadedModel = Awaited<ReturnType<typeof getModel>>

let inferenceTail: Promise<void> = Promise.resolve()

async function withInferenceLock<T>(run: () => Promise<T>): Promise<T> {
  const previous = inferenceTail
  let release!: () => void
  inferenceTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await run()
  } finally {
    release()
  }
}

async function runSegmentation(
  buffer: Buffer,
  width: number,
  height: number,
  model: PreTrainedModel,
  processor: LoadedModel['processor']
) {
  const image = await RawImage.fromBlob(new Blob([new Uint8Array(buffer)]))
  const modelInputs = await processor(image)
  const sessions = (model as PreTrainedModel & {
    sessions?: { model?: { inputNames?: string[]; outputNames?: string[] } }
  }).sessions
  const inputNames = sessions?.model?.inputNames
  const outputNames = sessions?.model?.outputNames
  if (inputNames && !inputNames.includes('pixel_values') && inputNames.length === 1) {
    const inputRecord = modelInputs as Record<string, unknown>
    inputRecord[inputNames[0]] = inputRecord.pixel_values
  }
  const modelOutput = await model(modelInputs)
  const outputTensor = getPrimaryOutputTensor(modelOutput, outputNames)

  let mask = RawImage.fromTensor(outputTensor.mul(255).to('uint8') as never)
  mask = await mask.resize(width, height)
  return mask.data
}

function applyMaskToAlpha(rgba: Buffer, maskData: Uint8Array | Uint8ClampedArray) {
  const composited = Buffer.from(rgba)
  for (let i = 0; i < maskData.length; i++) {
    composited[i * 4 + 3] = maskData[i]
  }
  return composited
}

export async function removeBackground(
  input: Buffer | Uint8Array,
  options: RemoveBackgroundOptions = {}
): Promise<RemoveBackgroundResult> {
  const bg = options.bg ?? 'transparent'
  const { model, processor } = await getModel()

  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)

  const { data: rgba, info } = await sharp(buffer)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width, height } = info
  const maskData = await withInferenceLock(() =>
    runSegmentation(buffer, width, height, model, processor)
  )
  const composited = applyMaskToAlpha(rgba, maskData)

  const base = sharp(composited, { raw: { width, height, channels: 4 } })
  const png =
    bg === 'transparent'
      ? await base.png().toBuffer()
      : await base.flatten({ background: bg }).png().toBuffer()

  return { png, width, height }
}
