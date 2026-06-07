const input = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==',
  'base64'
)

const endpoint = process.env.RMBG_ENDPOINT ?? 'http://127.0.0.1:3001/api/remove-bg'
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 60000)
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
const start = Date.now()

try {
  const form = new FormData()
  form.set('image', new File([input], 'tiny.png', { type: 'image/png' }))
  const res = await fetch(endpoint, { method: 'POST', body: form, signal: controller.signal })
  const bytes = Buffer.from(await res.arrayBuffer())
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${bytes.toString('utf8').slice(0, 500)}`)
  }
  const signature = bytes.subarray(0, 8).toString('hex')
  if (signature !== '89504e470d0a1a0a' || bytes.length < 50) {
    throw new Error(`invalid PNG response: ${bytes.length} bytes signature=${signature}`)
  }
  console.log(`ok ${bytes.length} bytes in ${Date.now() - start}ms`)
} finally {
  clearTimeout(timer)
}
