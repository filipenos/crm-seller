import type { TursoCredentials } from './config'

const API_URL = 'https://api.turso.tech/v1'
const DATABASE_NAME = 'crm-seller'

interface Organization {
  slug: string
  type: 'personal' | 'team'
}

interface Group {
  name: string
}

interface TursoDatabase {
  Name: string
  Hostname: string
}

async function request<T>(platformToken: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${platformToken}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {})
    }
  })
  const body = (await response.json().catch(() => null)) as T | { error?: string } | null
  if (!response.ok) {
    const errorBody =
      typeof body === 'object' && body !== null ? (body as { error?: string }) : null
    const detail = errorBody?.error ? `: ${errorBody.error}` : ''
    if (response.status === 401 || response.status === 403) {
      throw new Error(`O token da conta Turso é inválido ou não tem permissão${detail}.`)
    }
    throw new Error(`O Turso recusou a configuração (HTTP ${response.status})${detail}.`)
  }
  return body as T
}

async function chooseOrganization(platformToken: string): Promise<Organization> {
  const organizations = await request<Organization[]>(platformToken, '/organizations')
  const organization = organizations.find((item) => item.type === 'personal') ?? organizations[0]
  if (!organization?.slug) throw new Error('O token não possui acesso a uma organização Turso.')
  return organization
}

async function ensureGroup(platformToken: string, organization: string): Promise<string> {
  const path = `/organizations/${encodeURIComponent(organization)}/groups`
  const listed = await request<{ groups: Group[] }>(platformToken, path)
  const existing = listed.groups.find((group) => group.name === 'default') ?? listed.groups[0]
  if (existing) return existing.name

  const locations = await request<{ locations: Record<string, string> }>(platformToken, '/locations')
  const available = Object.keys(locations.locations)
  const location = available.includes('aws-us-east-1') ? 'aws-us-east-1' : available[0]
  if (!location) throw new Error('O Turso não informou nenhuma região disponível.')
  const created = await request<{ group: Group }>(platformToken, path, {
    method: 'POST',
    body: JSON.stringify({ name: 'default', location })
  })
  return created.group.name
}

async function ensureDatabase(
  platformToken: string,
  organization: string,
  group: string,
  onProgress: (message: string) => void
): Promise<TursoDatabase> {
  const path = `/organizations/${encodeURIComponent(organization)}/databases`
  onProgress('Procurando um banco existente…')
  const listed = await request<{ databases: TursoDatabase[] }>(platformToken, path)
  const existing = listed.databases.find((database) => database.Name === DATABASE_NAME)
  if (existing) {
    onProgress('Banco encontrado. Vamos usar o banco existente.')
    return existing
  }
  onProgress('Nenhum banco encontrado. Criando um novo…')
  const created = await request<{ database: TursoDatabase }>(platformToken, path, {
    method: 'POST',
    body: JSON.stringify({ name: DATABASE_NAME, group })
  })
  return created.database
}

/**
 * Usa o token amplo apenas durante o provisionamento. O que fica no computador
 * é um token restrito ao banco criado, reduzindo o impacto se a máquina vazar.
 */
export async function provisionTursoDatabase(
  platformTokenInput: string,
  onProgress: (message: string) => void = () => undefined
): Promise<TursoCredentials> {
  const platformToken = platformTokenInput.trim()
  if (!platformToken) throw new Error('Informe o token da sua conta Turso.')
  onProgress('Conectando à sua conta Turso…')
  const organization = await chooseOrganization(platformToken)
  onProgress('Verificando a estrutura da conta…')
  const group = await ensureGroup(platformToken, organization.slug)
  const database = await ensureDatabase(platformToken, organization.slug, group, onProgress)
  if (!database.Hostname) throw new Error('O Turso criou o banco, mas não informou o endereço.')

  const tokenPath =
    `/organizations/${encodeURIComponent(organization.slug)}/databases/` +
    `${encodeURIComponent(database.Name)}/auth/tokens?authorization=full-access&expiration=never`
  onProgress('Gerando uma credencial segura para o banco…')
  const token = await request<{ jwt: string }>(platformToken, tokenPath, { method: 'POST' })
  if (!token.jwt) throw new Error('O Turso não devolveu a credencial do banco.')
  return { url: `libsql://${database.Hostname}`, authToken: token.jwt }
}
