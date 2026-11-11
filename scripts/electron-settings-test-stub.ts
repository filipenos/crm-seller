import { join } from 'node:path'

export const app = {
  getPath(name: string): string {
    const root = process.env.CRM_SETTINGS_TEST_ROOT
    if (!root || !['documents', 'userData'].includes(name)) throw new Error('Caminho de teste inválido.')
    return join(root, name)
  }
}
