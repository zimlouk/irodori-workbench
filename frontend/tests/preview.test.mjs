import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'

// Compile the production modules with the project's existing TypeScript dependency.
const require = createRequire(import.meta.url)
const cache = new Map()
function load(relative, parent = fileURLToPath(new URL('../src/batch/', import.meta.url))) {
  const filename = path.resolve(parent, relative.endsWith('.ts') ? relative : relative + '.ts')
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports: {} }
  cache.set(filename, module)
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const localRequire = (id) => id.startsWith('.') ? load(id, path.dirname(filename)) : require(id)
  new Function('module', 'exports', 'require', source)(module, module.exports, localRequire)
  return module.exports
}

const { SequencePlayer } = load('sequence-player')
const { LivePreview } = load('live-preview')
const { previewPlaylist } = load('useBatchPreview')
const { voiceOverrides, matchingVoice, voiceSignature } = load('voice-selection')
class FakeAudio {
  src = ''; currentTime = 0; duration = 2; plays = []; pauses = 0; listeners = new Map(); reject = null
  addEventListener(name, handler) { this.listeners.set(name, handler) }
  removeEventListener(name) { this.listeners.delete(name) }
  play() { this.plays.push(this.src); return this.reject ? Promise.reject(this.reject) : Promise.resolve() }
  pause() { this.pauses++ }
  emit(name) { this.listeners.get(name)?.() }
}
class FakeClock {
  time = 0; tasks = new Map(); counter = 0
  now = () => this.time
  set = (callback, delay) => { const id = ++this.counter; this.tasks.set(id, { callback, at: this.time + delay }); return id }
  clear = (id) => this.tasks.delete(id)
  tick(milliseconds) {
    const target = this.time + milliseconds
    for (;;) {
      const next = [...this.tasks].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > target) break
      this.time = next[1].at; this.tasks.delete(next[0]); next[1].callback()
    }
    this.time = target
  }
}
const tracks = [1, 2, 3].map((n) => ({ ordinal: n, segmentId: 's' + n, jobId: 'j' + n, url: '/' + n + '.wav', text: 'line ' + n }))
function player() {
  const audio = new FakeAudio(), clock = new FakeClock()
  const engine = new SequencePlayer(audio, () => {}, clock)
  return { audio, clock, engine }
}
test('plays ordered sentences with exactly the configured silent gap', () => {
  const { audio, clock, engine } = player()
  engine.setGap(.5); engine.start(tracks)
  audio.emit('ended'); clock.tick(499)
  assert.deepEqual(audio.plays, ['/1.wav'])
  assert.equal(engine.snapshot().phase, 'gap')
  clock.tick(1); assert.deepEqual(audio.plays, ['/1.wav', '/2.wav'])
  audio.emit('ended'); clock.tick(500); audio.emit('ended')
  assert.equal(engine.snapshot().phase, 'ended')
  assert.deepEqual(audio.plays, ['/1.wav', '/2.wav', '/3.wav'])
})
test('pause preserves the remaining gap; manual skip cancels its pending timer', () => {
  const { audio, clock, engine } = player()
  engine.start(tracks); audio.emit('ended'); clock.tick(200); engine.pause()
  clock.tick(1000); assert.equal(audio.plays.length, 1)
  engine.resume(); clock.tick(299); assert.equal(audio.plays.length, 1)
  clock.tick(1); assert.equal(audio.plays.length, 2)
  audio.emit('ended'); engine.move(-1); clock.tick(1000)
  assert.equal(engine.snapshot().index, 0)
  assert.equal(audio.plays.at(-1), '/1.wav')
})
test('stopping, replacing the playlist and disposal cancel delayed playback', () => {
  const { audio, clock, engine } = player()
  engine.start(tracks); audio.emit('ended'); engine.start([tracks[2]])
  clock.tick(2000); assert.deepEqual(audio.plays, ['/1.wav', '/3.wav'])
  engine.stop(); audio.emit('ended'); clock.tick(2000)
  assert.equal(engine.snapshot().phase, 'idle')
  engine.start(tracks); audio.emit('ended'); engine.dispose(); clock.tick(2000)
  assert.equal(audio.plays.at(-1), '/1.wav'); assert.equal(audio.listeners.size, 0)
})
test('autoplay rejection exposes a resumable blocked state; later playback can recover', async () => {
  const { audio, engine } = player()
  audio.reject = Object.assign(new Error('blocked'), { name: 'NotAllowedError' })
  engine.start(tracks); await Promise.resolve()
  assert.equal(engine.snapshot().phase, 'blocked')
  assert.match(engine.snapshot().message, /点击/)
  audio.reject = null; engine.resume(); await Promise.resolve()
  assert.equal(engine.snapshot().phase, 'playing'); assert.equal(engine.snapshot().message, '')
})
test('late play rejection cannot replace the state of a newer playlist', async () => {
  const { audio, engine } = player()
  let reject
  audio.play = () => new Promise((_, no) => { reject = no })
  engine.start(tracks)
  const oldReject = reject
  audio.play = () => Promise.resolve()
  engine.start([tracks[2]])
  oldReject(Object.assign(new Error('late'), { name: 'NotAllowedError' })); await Promise.resolve()
  assert.equal(engine.snapshot().tracks[0].jobId, 'j3'); assert.equal(engine.snapshot().phase, 'playing')
})
test('an unreadable sentence is skipped without overlapping audio', () => {
  const { audio, engine } = player()
  engine.start(tracks); audio.emit('error')
  assert.equal(engine.snapshot().index, 1); assert.match(engine.snapshot().message, /已跳过/)
})
test('playlist uses selected valid versions in sentence order and skips stale or missing audio', () => {
  const segment = (n, extra = {}) => ({ id: 's' + n, text: 'text' + n, selected_job_id: 'j' + n,
    input_revision: 2, selected_stale: false, attempts: [{ id: 'j' + n, status: 'succeeded',
      input_revision: 2, audio_url: '/' + n, purged: false, stale: false }], ...extra })
  const playlist = previewPlaylist({ segments: [segment(1), segment(2, { selected_stale: true }),
    segment(3), segment(4, { selected_job_id: null })] })
  assert.deepEqual(playlist.tracks.map((t) => t.ordinal), [1, 3]); assert.equal(playlist.skipped, 2)
})
test('voice snapshot clears unrelated batch parameters; matching survives null defaults and key order', () => {
  const config = { lora_id: null, reference_asset_ids: ['b', 'a'], caption: 'soft',
    parameters: { seed: '1234567890123456789', max_ref_seconds: null, num_steps: 40 } }
  const overrides = voiceOverrides(config)
  assert.equal(overrides.parameters.cfg_scale_text, null)
  assert.equal(overrides.parameters.seed, '1234567890123456789')
  const same = { ...config, parameters: { num_steps: 40, seed: '1234567890123456789', max_ref_seconds: null, cfg_scale_text: null } }
  assert.equal(voiceSignature(config), voiceSignature(same))
  assert.equal(matchingVoice(same, [{ id: 'voice', config }]).id, 'voice')
  assert.notEqual(voiceSignature(config), voiceSignature({ ...config, reference_asset_ids: ['a', 'b'] }))
})

function liveBatch(id,statuses,round='round') {
  return {id,deleted_segments:[],segments:statuses.map((status,index)=>({
    id:id+'s'+index,text:'line '+index,input_revision:1,selected_stale:false,
    selected_job_id:status==='succeeded'?id+'j'+index:null,
    attempts:[{id:id+'j'+index,batch_id:round,status,input_revision:1,stale:false,purged:false,
      audio_url:status==='succeeded'?'/'+id+'/'+index+'.wav':null,text:'line '+index}],
  }))}
}
function livePlayer() {
  const audio=new FakeAudio(),clock=new FakeClock()
  let live
  const engine=new SequencePlayer(audio,()=>live?.playerChanged(),clock)
  live=new LivePreview(engine)
  return {audio,clock,engine,live}
}
test('live preview starts at the first generated sentence and never restarts it as later results arrive',()=>{
  const {audio,clock,engine,live}=livePlayer()
  live.observe(liveBatch('history',['succeeded']),true)
  assert.equal(audio.plays.length,0)
  live.observe(liveBatch('a',[]),true)
  live.observe(liveBatch('a',['running','pending']),true)
  assert.equal(engine.snapshot().phase,'waiting')
  live.observe(liveBatch('a',['succeeded','running']),true)
  assert.deepEqual(audio.plays,['/a/0.wav'])
  live.observe(liveBatch('a',['succeeded','succeeded']),true)
  assert.equal(audio.plays.length,1)
  audio.emit('ended');clock.tick(500)
  assert.deepEqual(audio.plays,['/a/0.wav','/a/1.wav'])
  audio.emit('ended');live.observe(liveBatch('a',['succeeded','succeeded']),true)
  assert.equal(engine.snapshot().phase,'ended');assert.equal(audio.plays.length,2)
})
test('clearing the editor does not pause the old batch and detached generation keeps extending its queue',()=>{
  const {audio,clock,engine,live}=livePlayer()
  live.observe(liveBatch('a',[]),true)
  live.observe(liveBatch('a',['running','pending']),true)
  live.observe(liveBatch('a',['succeeded','pending']),true)
  const pauses=audio.pauses
  live.observe(liveBatch('empty',[]),true)
  live.observe(null,true)
  assert.equal(audio.pauses,pauses);assert.equal(engine.snapshot().phase,'playing')
  assert.deepEqual(live.pendingBatchIds(),['a'])
  audio.emit('ended');clock.tick(900)
  assert.equal(engine.snapshot().phase,'waiting')
  live.observe(liveBatch('a',['succeeded','succeeded']),true);clock.tick(0)
  assert.deepEqual(audio.plays,['/a/0.wav','/a/1.wav'])
  assert.deepEqual(live.pendingBatchIds(),[])
})
test('another batch waits behind the current listening batch instead of stealing its audio',()=>{
  const {audio,clock,live}=livePlayer()
  live.observe(liveBatch('a',[]),true);live.observe(liveBatch('a',['pending']),true)
  live.observe(liveBatch('a',['succeeded']),true)
  live.observe(liveBatch('b',[]),true);live.observe(liveBatch('b',['pending']),true)
  live.observe(liveBatch('b',['succeeded']),true)
  assert.deepEqual(audio.plays,['/a/0.wav'])
  audio.emit('ended');clock.tick(0)
  assert.deepEqual(audio.plays,['/a/0.wav','/b/0.wav'])
})
test('a pending earlier sentence cannot be overtaken; failures are skipped in text order',()=>{
  const {audio,live}=livePlayer()
  live.observe(liveBatch('a',[]),true);live.observe(liveBatch('a',['pending','pending','pending']),true)
  live.observe(liveBatch('a',['failed','running','succeeded']),true)
  assert.deepEqual(audio.plays,[])
  live.observe(liveBatch('a',['failed','succeeded','succeeded']),true)
  assert.deepEqual(audio.plays,['/a/1.wav'])
})
test('waiting counts silence from the previous audio end and pause preserves the wait without replaying it',()=>{
  const {audio,clock,engine}=player()
  engine.start([tracks[0]],0,'',true);audio.emit('ended');clock.tick(200)
  engine.updateStream(tracks.slice(0,2),true)
  assert.equal(engine.snapshot().phase,'gap');clock.tick(299)
  assert.equal(audio.plays.length,1);clock.tick(1);audio.emit('ended')
  engine.pause();clock.tick(1000);engine.updateStream(tracks,false)
  assert.equal(audio.plays.length,2)
  engine.resume();clock.tick(0)
  assert.deepEqual(audio.plays,['/1.wav','/2.wav','/3.wav'])
})
test('stopping a live round suppresses future results but a genuinely new round may autoplay',()=>{
  const {audio,live,engine}=livePlayer()
  live.observe(liveBatch('a',[]),true);live.observe(liveBatch('a',['pending']),true)
  live.observe(liveBatch('a',['succeeded']),true);live.stop()
  live.observe(liveBatch('a',['succeeded']),true)
  assert.equal(engine.snapshot().phase,'idle');assert.equal(audio.plays.length,1)
  const next=liveBatch('a',['pending'],'new-round')
  next.segments[0].attempts[0].id='new-job'
  live.observe(next,true)
  const ready=structuredClone(next)
  ready.segments[0].selected_job_id='new-job'
  Object.assign(ready.segments[0].attempts[0],{status:'succeeded',audio_url:'/new.wav'})
  live.observe(ready,true)
  assert.equal(audio.plays.at(-1),'/new.wav')
})
test('turning off auto before the first result suppresses it and does not replay history when re-enabled',()=>{
  const {audio,live}=livePlayer()
  live.observe(liveBatch('a',[]),true);live.observe(liveBatch('a',['pending']),true)
  live.setAutomatic(false);live.observe(liveBatch('a',['succeeded']),false)
  live.observe(liveBatch('a',['succeeded']),true)
  assert.deepEqual(audio.plays,[])
})

test('manually replaying an ended round keeps new automatic batches waiting',()=>{
  const {audio,live}=livePlayer()
  live.observe(liveBatch('a',[]),true);live.observe(liveBatch('a',['pending']),true)
  live.observe(liveBatch('a',['succeeded']),true);audio.emit('ended')
  live.resume()
  live.observe(liveBatch('b',[]),true);live.observe(liveBatch('b',['succeeded']),true)
  assert.deepEqual(audio.plays,['/a/0.wav','/a/0.wav'])
  audio.emit('ended')
  assert.deepEqual(audio.plays,['/a/0.wav','/a/0.wav','/b/0.wav'])
})
