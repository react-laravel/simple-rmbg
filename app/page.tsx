'use client'

import { useCallback, useEffect, useState } from 'react'
import Dropzone from '@/components/Dropzone'
import ResultView from '@/components/ResultView'

type Bg = 'transparent' | 'white'
type ModelWeight = 'q4' | 'fp32'

export default function Home() {
  const [file, setFile] = useState<File | null>(null)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [bg, setBg] = useState<Bg>('transparent')
  const [weight, setWeight] = useState<ModelWeight>('q4')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      if (originalUrl) URL.revokeObjectURL(originalUrl)
      if (resultUrl) URL.revokeObjectURL(resultUrl)
    }
  }, [originalUrl, resultUrl])

  const process = useCallback(async (target: File, background: Bg, modelWeight: ModelWeight) => {
    setLoading(true)
    setError(null)
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })

    try {
      const form = new FormData()
      form.append('image', target)
      form.append('bg', background)
      form.append('weight', modelWeight)

      const res = await fetch('/api/remove-bg', { method: 'POST', body: form })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error ?? `请求失败：HTTP ${res.status}`)
      }

      const blob = await res.blob()
      setResultUrl(URL.createObjectURL(blob))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const handleFile = useCallback(
    (f: File) => {
      setFile(f)
      setOriginalUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(f)
      })
      void process(f, bg, weight)
    },
    [bg, process, weight]
  )

  const handleBgChange = useCallback(
    (next: Bg) => {
      setBg(next)
      if (file) void process(file, next, weight)
    },
    [file, process, weight]
  )

  const handleWeightChange = useCallback(
    (next: ModelWeight) => {
      setWeight(next)
      if (file) void process(file, bg, next)
    },
    [bg, file, process]
  )

  const reset = useCallback(() => {
    setFile(null)
    setOriginalUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setError(null)
  }, [])

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-8 px-5 py-10 sm:py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">去背景</h1>
      </header>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
        <label htmlFor="model-weight" className="mb-2 block text-sm font-medium text-neutral-200">
          RMBG-2.0 权重
        </label>
        <select
          id="model-weight"
          value={weight}
          onChange={(event) => handleWeightChange(event.target.value as ModelWeight)}
          disabled={loading}
          className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-emerald-500 disabled:opacity-50"
        >
          <option value="q4">Q4（推荐，约 333 MiB）</option>
          <option value="fp32">FP32 原始权重（约 977 MiB，速度更慢）</option>
        </select>
        <p className="mt-2 text-xs leading-5 text-neutral-500">
          两项都是最新版 RMBG-2.0；Q4 更节省资源，FP32 保留原始权重精度。
        </p>
      </section>

      {!originalUrl ? (
        <Dropzone onFile={handleFile} disabled={loading} />
      ) : (
        <div className="flex flex-col gap-5">
          <ResultView originalUrl={originalUrl} resultUrl={resultUrl} loading={loading} />

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 rounded-lg border border-neutral-800 p-1">
              <button
                type="button"
                onClick={() => handleBgChange('transparent')}
                disabled={loading}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                  bg === 'transparent' ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                透明背景
              </button>
              <button
                type="button"
                onClick={() => handleBgChange('white')}
                disabled={loading}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                  bg === 'white' ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                白色背景
              </button>
            </div>

            <a
              href={resultUrl ?? undefined}
              download={`removed-bg-${bg}.png`}
              aria-disabled={!resultUrl || loading}
              className={`rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-neutral-950 transition-colors hover:bg-emerald-400 ${
                !resultUrl || loading ? 'pointer-events-none opacity-50' : ''
              }`}
            >
              下载 PNG
            </a>

            <button
              type="button"
              onClick={reset}
              disabled={loading}
              className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 disabled:opacity-50"
            >
              换一张
            </button>
          </div>

          {error && (
            <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          )}
        </div>
      )}

      </main>
  )
}
