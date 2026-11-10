/**
 * Test output parsing for `apple_dev_test`.
 *
 * Two runners can produce the output: XCTest (the classic `Test Suite` /
 * `Test Case` / `Executed N tests` vocabulary, also used by `xcodebuild test`)
 * and Swift Testing (newer `Test run with N tests` lines). Both are parsed so
 * the tool can report counts and per-test failures instead of raw log noise.
 */

const SUITE_ALL_RESULT = /^Test Suite 'All tests' (passed|failed)/
const EXECUTED = /^Executed (\d+) tests?, with (\d+) failures?(?: \((\d+) unexpected\))?/
const CASE_BRACKET = /^Test Case '-\[([^\]\s]+) ([^\]]+)\]' (passed|failed|skipped)/
const CASE_QUOTED = /^Test Case '(.+?)' (passed|failed|skipped)/
const FAILURE_DETAIL = /^(.+?):(\d+)(?::(\d+))?:\s*(error|warning):\s+-\[([^\]\s]+) ([^\]]+)\] :\s*(.+)$/
const FILE_ERROR = /^(.+?):(\d+)(?::(\d+))?:\s*(?:error|warning):\s*(.+)$/
const BARE_ERROR = /^(?:(?:fatal|swift) error|error):\s*(.+)$/
const FAILING_TESTS_HEADER = /^Failing tests:/
const TESTING_RUN = /^(?:[\u2714\u2718]\s*)?Test run with (\d+) tests?(?: in \d+ suites?)? (passed|failed)/
const TESTING_CASE_RESULT = /^[✔✘]\s+Test\s+"?([^"(]+?)"?(?:\(| failed| passed| recorded)/

const MAX_FAILING_TESTS = 40
const MAX_ERRORS = 40

function emptyTestParse() {
  return {
    result: 'unknown',
    passed: undefined,
    suiteResult: undefined,
    executed: undefined,
    failureCount: undefined,
    unexpectedFailures: undefined,
    caseCounts: { passed: 0, failed: 0, skipped: 0 },
    failingTests: [],
    failingTestCount: 0,
    errors: [],
    errorCount: 0,
  }
}

function addFailing(parsed, seen, entry) {
  // A XCTest failure appears twice: on the `Test Case ... failed` line (no
  // location) and on the `file:line: error: -[...] : message` detail line.
  // Merge both into one failure keyed by suite + test name.
  const key = `${entry.suite || ''}|${entry.name || ''}`
  const existing = seen.get(key)
  if (existing) {
    if (entry.file && !existing.file) existing.file = entry.file
    if (entry.line && !existing.line) existing.line = entry.line
    if (entry.column && !existing.column) existing.column = entry.column
    if (entry.message && !existing.message) existing.message = entry.message
    return
  }
  seen.set(key, entry)
  parsed.failingTestCount += 1
  if (parsed.failingTests.length < MAX_FAILING_TESTS) parsed.failingTests.push(entry)
}

function addError(parsed, seen, entry) {
  const key = `${entry.file || ''}|${entry.line || ''}|${entry.message}`
  if (seen.has(key)) return
  seen.add(key)
  parsed.errorCount += 1
  if (parsed.errors.length < MAX_ERRORS) parsed.errors.push(entry)
}

/**
 * Parse combined `xcodebuild test` / `swift test` output.
 *
 * @param {string} text
 * @returns {{ result: 'passed'|'failed'|'unknown', passed: boolean|undefined,
 *   suiteResult?: 'passed'|'failed', executed?: number, failureCount?: number,
 *   unexpectedFailures?: number, caseCounts: { passed: number, failed: number, skipped: number },
 *   failingTests: object[], failingTestCount: number, errors: object[], errorCount: number }}
 */
export function parseTestOutput(text) {
  const value = typeof text === 'string' ? text : ''
  const parsed = emptyTestParse()
  const seenFailing = new Map()
  const seenErrors = new Set()
  let inFailingTests = false
  let xctestSummarySeen = false
  let testingSummary = undefined
  let sawTestSucceeded = false
  let sawTestFailed = false

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (inFailingTests) {
      if (line.length === 0) {
        inFailingTests = false
        continue
      }
      if (/^\s+/.test(rawLine)) {
        const identifier = line.replace(/\(\)$/, '').replace(/,$/, '').trim()
        if (identifier.length > 0 && identifier.includes('.')) {
          const parts = identifier.split('.')
          const name = parts.pop()
          addFailing(parsed, seenFailing, { suite: parts.join('.'), name })
        }
        continue
      }
      inFailingTests = false
    }

    if (/^\*\* TEST SUCCEEDED \*\*$/.test(line)) {
      sawTestSucceeded = true
      continue
    }
    if (/^\*\* TEST FAILED \*\*$/.test(line)) {
      sawTestFailed = true
      continue
    }

    const suiteAll = SUITE_ALL_RESULT.exec(line)
    if (suiteAll) {
      parsed.suiteResult = suiteAll[1]
      xctestSummarySeen = true
      continue
    }

    const executed = EXECUTED.exec(line)
    if (executed) {
      parsed.executed = Number(executed[1])
      parsed.failureCount = Number(executed[2])
      parsed.unexpectedFailures = executed[3] === undefined ? undefined : Number(executed[3])
      xctestSummarySeen = true
      continue
    }

    const bracketCase = CASE_BRACKET.exec(line)
    if (bracketCase) {
      const status = bracketCase[3]
      if (status === 'passed') parsed.caseCounts.passed += 1
      else if (status === 'failed') {
        parsed.caseCounts.failed += 1
        addFailing(parsed, seenFailing, { suite: bracketCase[1], name: bracketCase[2] })
      } else parsed.caseCounts.skipped += 1
      continue
    }

    const quotedCase = CASE_QUOTED.exec(line)
    if (quotedCase) {
      const status = quotedCase[2]
      const identifier = quotedCase[1]
      if (status === 'passed') parsed.caseCounts.passed += 1
      else if (status === 'failed') {
        parsed.caseCounts.failed += 1
        const parts = identifier.split('.')
        const name = parts.pop()
        addFailing(parsed, seenFailing, { suite: parts.join('.'), name })
      } else parsed.caseCounts.skipped += 1
      continue
    }

    const detail = FAILURE_DETAIL.exec(line)
    if (detail) {
      if (detail[4] === 'error') {
        addFailing(parsed, seenFailing, {
          suite: detail[5],
          name: detail[6],
          file: detail[1].trim(),
          line: Number(detail[2]),
          message: detail[7].trim(),
        })
      }
      continue
    }

    const fileError = FILE_ERROR.exec(line)
    if (fileError) {
      addError(parsed, seenErrors, {
        file: fileError[1].trim(),
        line: Number(fileError[2]),
        column: fileError[3] === undefined ? undefined : Number(fileError[3]),
        message: fileError[4].trim(),
      })
      continue
    }

    const bareError = BARE_ERROR.exec(line)
    if (bareError) {
      addError(parsed, seenErrors, { message: bareError[1].trim() })
      continue
    }

    if (FAILING_TESTS_HEADER.test(line)) {
      inFailingTests = true
      continue
    }

    const testingRun = TESTING_RUN.exec(line)
    if (testingRun) {
      testingSummary = { executed: Number(testingRun[1]), result: testingRun[2] }
      continue
    }

    const testingCase = TESTING_CASE_RESULT.exec(line)
    if (testingCase) {
      if (line.startsWith('✘')) {
        parsed.caseCounts.failed += 1
        addFailing(parsed, seenFailing, { name: testingCase[1].trim() })
      } else if (line.startsWith('✔')) {
        parsed.caseCounts.passed += 1
      }
      continue
    }
  }

  // Swift Testing runs next to an XCTest suite in one `swift test` invocation:
  // XCTest reports `Executed 0 tests` while Swift Testing reports its own
  // suite. Prefer the larger, more specific count instead of answering
  // "0 tests" for a run that executed tests.
  if (testingSummary) {
    const executed = parsed.executed ?? 0
    if (testingSummary.executed > executed) {
      parsed.executed = testingSummary.executed
      parsed.failureCount = testingSummary.result === 'failed'
        ? Math.max(parsed.failureCount ?? 0, 1)
        : (parsed.failureCount ?? 0)
      parsed.unexpectedFailures = parsed.unexpectedFailures ?? 0
    }
  }

  if (parsed.suiteResult === 'failed' || sawTestFailed || (testingSummary && testingSummary.result === 'failed')) {
    parsed.result = 'failed'
  } else if (parsed.suiteResult) {
    parsed.result = parsed.suiteResult
  } else if (parsed.executed !== undefined && parsed.failureCount !== undefined) {
    parsed.result = parsed.failureCount > 0 ? 'failed' : 'passed'
  } else if (testingSummary) {
    parsed.executed = testingSummary.executed
    parsed.failureCount = testingSummary.result === 'passed' ? 0 : undefined
    parsed.result = testingSummary.result === 'passed' ? 'passed' : 'failed'
  } else if (sawTestFailed) {
    parsed.result = 'failed'
  } else if (sawTestSucceeded) {
    parsed.result = 'passed'
  } else if (parsed.caseCounts.failed > 0 || parsed.failingTestCount > 0) {
    parsed.result = 'failed'
  } else if (parsed.caseCounts.passed > 0 && parsed.errorCount === 0) {
    parsed.result = 'passed'
  }
  parsed.passed = parsed.result === 'passed' ? true : parsed.result === 'failed' ? false : undefined
  return parsed
}
