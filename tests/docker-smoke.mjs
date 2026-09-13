import http from 'node:http'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const image = process.argv[2] || 'mealie-calorie-estimator:local'
const name = `mealie-pipeline-smoke-${process.pid}`
const cache = mkdtempSync(join(tmpdir(), 'mealie-cache-'))
chmodSync(cache, 0o777)
const ingredient = { quantity: 600, unit: { name: 'g' }, food: { name: 'Reis' }, originalText: '600 g Reis' }
const initial = { slug: 'smoke', name: 'Smoke recipe', recipeYield: '8 servings', recipeServings: null, recipeIngredient: [ingredient], nutrition: null, extras: {}, tags: [] }
let recipe = structuredClone(initial)
let patches = []
let normalizations = 0
const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/v1/chat/completions') {
    normalizations++
    const rows = [{ index: 0, original: '600 g Reis', name: 'rice', searchName: 'rice dry', amount: 600, unit: 'g', estimatedAmount: false, state: 'dry', generic: true, brand: null, category: 'grain', confidence: 0.95 }]
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ingredients: rows }) } }] }))
  } else if (req.url === '/api/recipes/smoke' && req.headers.authorization === 'Bearer smoke-token') {
    if (req.method === 'PATCH') {
      const patch = JSON.parse(body)
      patches.push(patch)
      recipe = { ...recipe, ...patch }
    }
    res.end(JSON.stringify(recipe))
  } else { res.statusCode = 404; res.end('{}') }
})
await new Promise(resolve => server.listen(19090, '0.0.0.0', resolve))
const docker = (...args) => execFileSync('docker', args, { stdio: 'pipe' }).toString()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  for (let i = 0; i < 100; i++) {
    try { if (await check()) return } catch {}
    await delay(200)
  }
  throw new Error('Smoke test timed out')
}
async function run() {
  docker('run', '-d', '--name', name, '--network', 'host', '-v', `${cache}:/app/data`,
    '-e', 'PORT=18080', '-e', 'MEALIE_URL=http://127.0.0.1:19090', '-e', 'MEALIE_API_TOKEN=smoke-token',
    '-e', 'LLM_ENABLED=true', '-e', 'LLM_API_KEY=smoke-key', '-e', 'LLM_BASE_URL=http://127.0.0.1:19090/v1', image)
  await until(async () => (await fetch('http://127.0.0.1:18080/health')).ok)
}
async function webhook() {
  const response = await fetch('http://127.0.0.1:18080/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'recipe.created', document_data: JSON.stringify({ document_type: 'recipe', recipe_slug: 'smoke', operation: 'create' }) }) })
  assert.equal(response.status, 202)
}
try {
  await run()
  await webhook()
  await until(() => patches.length === 1)
  assert.equal(patches[0].nutrition.calories, '274') // 600 * 365 / 100 / 8, rounded for Mealie
  assert.deepEqual(Object.keys(patches[0]).sort(), ['extras', 'nutrition'])
  assert.deepEqual(recipe.recipeIngredient, initial.recipeIngredient)
  assert.equal(recipe.recipeYield, '8 servings')
  await webhook()
  await delay(500)
  assert.equal(patches.length, 1)
  assert.equal(normalizations, 1)
  docker('stop', name)
  docker('rm', name)
  recipe = structuredClone(initial)
  patches = []
  await run()
  await webhook()
  await until(() => patches.length === 1)
  assert.equal(normalizations, 1, 'normalization cache must survive container restart')
  assert.equal(patches[0].nutrition.calories, '274')
  console.log('Docker smoke passed: authenticated webhook, nutrition-only PATCH, idempotency and persistent cache')
} catch (error) {
  try { console.error(docker('logs', name)) } catch {}
  throw error
} finally {
  try { docker('rm', '-f', name) } catch {}
  await new Promise(resolve => server.close(resolve))
  rmSync(cache, { recursive: true, force: true })
}
