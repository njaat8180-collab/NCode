import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { intervalsOverlap, wilsonInterval } from './benchmark-statistics.mjs';

const [NCodePath, baselinePath] = process.argv.slice(2);
if (!NCodePath || !baselinePath) {
  console.error('Usage: node scripts/smoke/compare-benchmark.mjs <NCode-summary.json> <baseline-summary.json>');
  process.exit(2);
}

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const metric = (summary, key) => key.split('.').reduce((value, part) => value?.[part], summary.aggregate);
const NCode = read(NCodePath);
const baseline = read(baselinePath);
const sameProtocol = NCode.protocol && baseline.protocol && NCode.protocol === baseline.protocol;
const sameCases = NCode.caseSetFingerprint && baseline.caseSetFingerprint && NCode.caseSetFingerprint === baseline.caseSetFingerprint;
const sameEvaluatorContract = NCode.evaluatorContractFingerprint && baseline.evaluatorContractFingerprint &&
  NCode.evaluatorContractFingerprint === baseline.evaluatorContractFingerprint;
function hasSummarySchema3Metrics(summary) {
  const aggregate = summary.aggregate;
  const attempted = aggregate?.attempted;
  const attemptMetrics = ['total', 'medianDurationMs', 'p95DurationMs', 'medianProviderOrEstimatedTokens', 'p95ProviderOrEstimatedTokens', 'medianModelCalls', 'p95ModelCalls'];
  const repair = aggregate?.repair;
  const regressionNames = ['behavioralFailureRuns', 'tokenBudgetFailureRuns', 'independentCheckFailureRuns', 'browserCheckFailureRuns', 'protectedFileRegressionRuns', 'unexpectedFileCreationRuns', 'forbiddenLeakRuns'];
  const regressions = aggregate?.regressions;
  const accounting = attempted?.tokenAccounting;
  const accountingCounts = ['accountedRuns', 'providerReportedRuns', 'mixedReportedRuns', 'estimatedRuns', 'zeroCallRuns', 'unaccountedRuns'];
  const hasValidAccounting = accounting && accountingCounts.every(key => Number.isInteger(accounting[key]) && accounting[key] >= 0) &&
    accountingCounts.slice(1).reduce((sum, key) => sum + accounting[key], 0) === attempted.total &&
    accounting.accountedRuns === attempted.total && accounting.unaccountedRuns === 0 && accounting.coveragePercent === 100;
  return summary.summarySchemaVersion === 3 && attempted && attemptMetrics.every(key => Number.isFinite(attempted[key])) && hasValidAccounting &&
    attempted.total === aggregate.total && repair && ['runsWithRepairPhase', 'repairPhaseCount', 'failedAfterRepairCount'].every(key => Number.isFinite(repair[key])) &&
    regressions && regressionNames.every(key => Number.isFinite(regressions[key]));
}
const sameSummarySchema = hasSummarySchema3Metrics(NCode) && hasSummarySchema3Metrics(baseline) &&
  NCode.summarySchemaVersion === baseline.summarySchemaVersion;
const sameHardware = NCode.environment?.hardwareKey && baseline.environment?.hardwareKey &&
  NCode.environment.hardwareKey === baseline.environment.hardwareKey;
function hasAllRuns(summary) {
  const {caseIds, reports, runSettings} = summary;
  if (!Array.isArray(caseIds) || !caseIds.length || new Set(caseIds).size !== caseIds.length ||
      !Array.isArray(reports) || !Number.isInteger(runSettings?.repeats) || runSettings.repeats < 3 ||
      !(runSettings.timeoutMs > 0) || typeof runSettings.acceptanceProvided !== 'boolean') return false;
  const completed = new Set(reports.map(report => JSON.stringify([report.case, report.repetition])));
  return reports.length === caseIds.length * runSettings.repeats && summary.aggregate?.total === reports.length &&
    caseIds.every(id => Array.from({length: runSettings.repeats}, (_, i) => completed.has(JSON.stringify([id, i + 1]))).every(Boolean));
}
const enoughRepeats = [NCode, baseline].every(summary =>
  Number.isInteger(summary.runSettings?.repeats) && summary.runSettings.repeats >= 3);
const comparable = sameProtocol && sameCases && sameEvaluatorContract && sameSummarySchema && sameHardware && isDeepStrictEqual(NCode.runSettings, baseline.runSettings) &&
  hasAllRuns(NCode) && hasAllRuns(baseline) && isDeepStrictEqual([...NCode.caseIds].sort(), [...baseline.caseIds].sort());
const metrics = [
  ['passRatePercent', 'higher-is-better'],
  ['medianProviderOrEstimatedTokens', 'lower-is-better'],
  ['p95ProviderOrEstimatedTokens', 'lower-is-better'],
  ['medianToolCalls', 'lower-is-better'],
  ['p95ToolCalls', 'lower-is-better'],
  ['medianDurationMs', 'lower-is-better'],
  ['p95DurationMs', 'lower-is-better'],
  ['attempted.medianDurationMs', 'lower-is-better'],
  ['attempted.p95DurationMs', 'lower-is-better'],
  ['attempted.medianProviderOrEstimatedTokens', 'lower-is-better'],
  ['attempted.p95ProviderOrEstimatedTokens', 'lower-is-better'],
  ['attempted.medianModelCalls', 'lower-is-better'],
  ['attempted.p95ModelCalls', 'lower-is-better'],
  ['repair.runsWithRepairPhase', 'informational'],
  ['repair.failedAfterRepairCount', 'lower-is-better'],
  ['regressions.independentCheckFailureRuns', 'lower-is-better'],
  ['regressions.protectedFileRegressionRuns', 'lower-is-better'],
  ['regressions.unexpectedFileCreationRuns', 'lower-is-better'],
  ['regressions.forbiddenLeakRuns', 'lower-is-better'],
];
const rows = metrics.map(([name, direction]) => {
  const q = Number(metric(NCode, name));
  const b = Number(metric(baseline, name));
  const deltaPercent = Number.isFinite(q) && Number.isFinite(b) && b !== 0 ? ((q - b) / b) * 100 : null;
  const needsSuccessfulRuns = name !== 'passRatePercent' && !name.startsWith('attempted.') && !name.startsWith('repair.') && !name.startsWith('regressions.');

  let better;
  let qInterval = null;
  let bInterval = null;

  if (name === 'passRatePercent' && comparable && Number.isFinite(q) && Number.isFinite(b)) {
    const qPassed = NCode.aggregate?.passed ?? 0;
    const qTotal = NCode.aggregate?.total ?? 0;
    const bPassed = baseline.aggregate?.passed ?? 0;
    const bTotal = baseline.aggregate?.total ?? 0;
    qInterval = wilsonInterval(qPassed, qTotal);
    bInterval = wilsonInterval(bPassed, bTotal);
    // Identical pass rates are a definite tie before the descriptive Wilson
    // overlap check; the interval is descriptive, not a significance test, so
    // equal point estimates must not be reported as merely inconclusive.
    better = q === b ? 'tie' : intervalsOverlap(qInterval, bInterval)
      ? 'inconclusive' : (direction === 'higher-is-better' ? q > b : q < b) ? 'NCode' : 'baseline';
  } else {
    better = !comparable || !Number.isFinite(q) || !Number.isFinite(b) ||
      (needsSuccessfulRuns && (!NCode.aggregate?.passed || !baseline.aggregate?.passed)) ? 'unavailable'
      : direction === 'informational' ? 'informational'
        : q === b ? 'tie' : (direction === 'higher-is-better' ? q > b : q < b) ? 'NCode' : 'baseline';
  }

  const row = { metric: name, NCode: q, baseline: b, deltaPercent: deltaPercent === null ? null : Math.round(deltaPercent * 100) / 100, better };
  if (qInterval) row.NCodeWilson = { lower: Math.round(qInterval.lower * 10000) / 100, upper: Math.round(qInterval.upper * 10000) / 100 };
  if (bInterval) row.baselineWilson = { lower: Math.round(bInterval.lower * 10000) / 100, upper: Math.round(bInterval.upper * 10000) / 100 };
  return row;
});
const result = {
  status: comparable ? 'COMPARABLE' : 'NOT_COMPARABLE',
  NCode: { model: NCode.model, cases: NCode.aggregate?.total, passed: NCode.aggregate?.passed, tokenAccounting: NCode.aggregate?.attempted?.tokenAccounting },
  baseline: { model: baseline.model, cases: baseline.aggregate?.total, passed: baseline.aggregate?.passed, tokenAccounting: baseline.aggregate?.attempted?.tokenAccounting },
  comparability: comparable ? 'same protocol, evaluator contract, summary schema, selected tasks, run settings, hardware fingerprint and repetition coverage'
    : !sameHardware ? 'hardware fingerprint missing or mismatched'
      : !sameEvaluatorContract ? 'evaluator contract fingerprint missing or mismatched'
  : !sameSummarySchema ? 'summary schema is missing, stale, mismatched, or token accounting is incomplete'
  : !enoughRepeats ? 'at least three repeated trials per case are required'
        : 'protocol, selected cases, settings or run coverage missing or mismatched',
  metrics: rows,
  notes: 'Wilson intervals are descriptive 95% confidence intervals for binomial proportions. They are not a significance test. Repeated runs on the same cases are correlated, violating independence assumptions.',
};
console.log(JSON.stringify(result, null, 2));
if (!comparable) process.exitCode = 1;
