export type ModelWeight = 'q4' | 'fp32'

export type BackgroundOption = 'transparent' | string

export interface RemoveBackgroundResult {
  png: Buffer
  width: number
  height: number
}

export interface RemoveBackgroundOptions {
  bg?: BackgroundOption
  weight?: ModelWeight
}
