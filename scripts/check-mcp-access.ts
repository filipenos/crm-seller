import assert from 'node:assert/strict'
import { mcpAccessStatus } from '../src/main/services/mcpAccess'

const request = { url: '/mcp', method: 'POST', host: '127.0.0.1:38765', origin: undefined, authorization: undefined }
const local = { lan: false, localPort: 38765, lanPort: 38766, addresses: ['192.168.1.10'] }
const lan = { ...local, lan: true, token: 'test-token' }

assert.equal(mcpAccessStatus(request, local), null)
assert.equal(mcpAccessStatus({ ...request, host: 'evil.example:38765' }, local), 403)
assert.equal(mcpAccessStatus({ ...request, origin: 'https://evil.example' }, local), 403)
assert.equal(mcpAccessStatus({ ...request, url: '/settings' }, local), 404)
assert.equal(mcpAccessStatus({ ...request, host: '192.168.1.10:38766' }, lan), 401)
assert.equal(mcpAccessStatus({ ...request, host: '192.168.1.10:38766', authorization: 'Bearer wrong' }, lan), 401)
assert.equal(mcpAccessStatus({ ...request, host: '192.168.1.10:38766', authorization: 'Bearer test-token' }, lan), null)
assert.equal(mcpAccessStatus({ ...request, host: 'other.example:38766', authorization: 'Bearer test-token' }, lan), 403)
