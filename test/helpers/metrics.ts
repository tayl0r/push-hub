// Read one absolute series value from the module-global registry — the one place that
// knows how this repo reads a prom-client series (base-name strip + metricName match).
// For a histogram, pass the derived name directly, e.g. 'db_query_duration_seconds_count'.
import { register } from '../../src/metrics.js'

export async function readSeries(fullName: string, labels: Record<string, string> = {}): Promise<number | undefined> {
  const baseName = fullName.replace(/_(count|sum)$/, '')
  const metric = register.getSingleMetric(baseName)
  if (!metric) return undefined
  const data: any = await metric.get()
  const match = data.values.find((v: any) => {
    const nameMatches = (v.metricName ?? data.name) === fullName
    return nameMatches && Object.entries(labels).every(([k, val]) => String(v.labels[k] ?? '') === val)
  })
  return match?.value
}
