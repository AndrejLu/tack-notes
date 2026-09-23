import type { IpcApi } from '@shared/ipc'

declare global {
  interface Window {
    tack: IpcApi
  }
}

export {}
