export const app = {
  getPath(): string {
    throw new Error('O teste isolado não deve acessar o diretório de dados do Electron.')
  }
}

export const safeStorage = {
  decryptString(): string {
    throw new Error('O teste isolado não deve acessar credenciais.')
  },
  encryptString(): Buffer {
    throw new Error('O teste isolado não deve gravar credenciais.')
  },
  isEncryptionAvailable(): boolean {
    return false
  }
}

export const BrowserWindow = class {
  constructor() { throw new Error('O teste isolado não deve abrir janelas.') }
  static getAllWindows(): never { throw new Error('O teste isolado não deve abrir janelas.') }
}

export const session = {
  fromPartition(): never { throw new Error('O teste isolado não deve acessar sessões.') }
}
