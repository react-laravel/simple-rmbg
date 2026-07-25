import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '去背景',
  description: '基于 RMBG-2.0 本地模型的图片去背景应用，支持网页与 API 调用。',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
