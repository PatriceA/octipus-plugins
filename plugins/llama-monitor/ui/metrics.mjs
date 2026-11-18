// Shared pure functions: no network, filesystem, credentials or global user state.
export const FIELDS = {
  prefillTps: ['Prefill', 'tok/s'], outputTps: ['Output', 'tok/s'],
  cpuPercent: ['CPU usage', '%'], ramTotalBytes: ['System RAM total', 'bytes'],
  ramAvailableBytes: ['System RAM available', 'bytes'], ramUsedBytes: ['System RAM used', 'bytes'],
  containerLimitBytes: ['Container RAM limit', 'bytes'], containerUsedBytes: ['Container RAM used', 'bytes'],
  swapUsedBytes: ['Swap used', 'bytes'], vramTotalBytes: ['GPU VRAM total', 'bytes'],
  vramUsedBytes: ['GPU VRAM used', 'bytes'], vramAvailableBytes: ['GPU VRAM available', 'bytes'],
  gpuPercent: ['GPU usage', '%'], gpuTemperatureC: ['GPU temperature', '°C'],
  gpuPowerWatts: ['GPU power', 'W'], processRssBytes: ['Engine resident RAM', 'bytes'],
  requestsProcessing: ['Requests active', 'requests'], requestsDeferred: ['Requests queued', 'requests'],
  contextHighWater: ['Context high-water mark', 'tokens'], latencyMs: ['Probe latency', 'ms']
};
const number = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
export function prometheus(text) {
  if (typeof text !== 'string' || text.length > 1000000) throw new Error('Metrics must be text, at most 1 MB.');
  const result = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+([^\s]+)(?:\s+\d+)?\s*$/);
    if (!m) continue;
    const n = number(Number(m[2]));
    if (n !== null) result[m[1]] = (result[m[1]] ?? 0) + n;
  }
  return result;
}
export function profile(input) {
  if (!input || typeof input !== 'object') throw new Error('Engine profile required.');
  const name = String(input.name || '').trim();
  if (!name || name.length > 80) throw new Error('Engine name must contain 1–80 characters.');
  const url = new URL(String(input.url || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) engine base URL without credentials, query or fragment.');
  const connection = String(input.connection || '').trim();
  if (connection && !/^[a-zA-Z0-9_-]{1,80}$/.test(connection)) throw new Error('Use a configured connection name, never a token.');
  const telemetryConnection = String(input.telemetryConnection || '').trim();
  if (telemetryConnection && !/^[a-zA-Z0-9_-]{1,80}$/.test(telemetryConnection)) throw new Error('Use an approved telemetry connection name.');
  return { id: String(input.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0,80), name, url: url.href.replace(/\/$/, ''), connection, telemetryConnection };
}
export function normalize(input, previous = null) {
  if (!input || typeof input !== 'object') throw new Error('Snapshot object required.');
  const at = Date.parse(input.at);
  if (!Number.isFinite(at)) throw new Error('Snapshot needs a valid at timestamp.');
  const m = prometheus(input.metrics || '');
  const host = input.host || {};
  const values = Object.fromEntries(Object.keys(FIELDS).map(k => [k, number(host[k])]));
  values.latencyMs = number(input.latencyMs);
  values.requestsProcessing = number(m['llamacpp:requests_processing']);
  values.requestsDeferred = number(m['llamacpp:requests_deferred']);
  values.contextHighWater = number(m['llamacpp:n_tokens_max']);
  const counters = {
    promptTokens: number(m['llamacpp:prompt_tokens_total']),
    promptSeconds: number(m['llamacpp:prompt_seconds_total']),
    outputTokens: number(m['llamacpp:tokens_predicted_total']),
    outputSeconds: number(m['llamacpp:tokens_predicted_seconds_total'])
  };
  // Counter deltas measure active processing throughput, not stale lifetime gauges.
  let reset = false;
  for (const [field, tokens, seconds] of [['prefillTps','promptTokens','promptSeconds'], ['outputTps','outputTokens','outputSeconds']]) {
    const a = counters[tokens], b = counters[seconds], pa = previous?.counters?.[tokens], pb = previous?.counters?.[seconds];
    values[field] = null;
    if ([a,b,pa,pb].every(x => number(x) !== null) && at > Date.parse(previous.at)) {
      if (a < pa || b < pb) reset = true;
      else if (a > pa && b > pb) values[field] = (a-pa)/(b-pb);
    }
  }
  const data = Array.isArray(input.models?.data) ? input.models.data : [];
  const models = data.slice(0,100).map(x => ({
    name: String(x.id || x.name || 'Unnamed model').slice(0,300),
    state: typeof x.status === 'object' ? String(x.status.value || 'unknown') : String(x.status || 'advertised')
  }));
  // An OpenAI model listing does not establish residency.
  const warnings = (Array.isArray(input.warnings) ? input.warnings : []).slice(0,20).map(x=>String(x).slice(0,500));
  if (!input.host) warnings.push('Host collector unavailable: RAM, CPU and GPU readings are unknown.');
  if (!input.metrics) warnings.push('Metrics unavailable. Enable llama-server --metrics.');
  if (reset) warnings.push('Engine counters reset; throughput baseline restarted.');
  return { at: new Date(at).toISOString(), engineId: String(input.engineId || ''), models, values, counters, warnings, reset, hostScope: String(input.hostScope || 'Host scope unavailable').slice(0,500), health: String(input.health?.status || 'unknown').slice(0,100), sleeping: typeof input.props?.is_sleeping === 'boolean' ? input.props.is_sleeping : null };
}
export function summarize(samples) {
  if (!Array.isArray(samples) || samples.length > 5000) throw new Error('Session must contain at most 5000 samples.');
  const rows = samples.filter(x => Number.isFinite(Date.parse(x?.at)));
  const metrics = {};
  for (const [key,[label,unit]] of Object.entries(FIELDS)) {
    const values = rows.map(x=>number(x.values?.[key])).filter(x=>x !== null);
    metrics[key] = { label, unit, count: values.length, low: values.length ? Math.min(...values) : null, peak: values.length ? Math.max(...values) : null, average: values.length ? values.reduce((a,b)=>a+b,0)/values.length : null };
  }
  return { count: rows.length, startedAt: rows[0]?.at ?? null, stoppedAt: rows.at(-1)?.at ?? null, metrics, averageMethod: 'Arithmetic mean of valid samples; inactive or missing throughput samples excluded.' };
}
