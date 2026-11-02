/** Watch the v0.6.7 release run until it finishes, then report the release assets. */
const repo = 'touwaeriol/prophey'
const headers = { 'user-agent': 'prophey-release-watch', accept: 'application/vnd.github+json' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

;(async () => {
  for (let attempt = 0; attempt < 80; attempt++) {
    const runs = await (await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=5`, { headers })).json()
    const run = (runs.workflow_runs ?? []).find((entry) => entry.head_branch === 'v0.6.7')
    if (run) {
      console.log(`[${new Date().toISOString()}] ${run.status} ${run.conclusion ?? ''} ${run.html_url}`)
      if (run.status === 'completed') {
        const jobs = await (await fetch(run.jobs_url, { headers })).json()
        for (const job of jobs.jobs ?? []) {
          console.log(`  job ${job.name}: ${job.conclusion}`)
          for (const step of job.steps ?? []) {
            if (step.conclusion && step.conclusion !== 'success') console.log(`    step ${step.name}: ${step.conclusion}`)
          }
        }
        const release = await (await fetch(`https://api.github.com/repos/${repo}/releases/tags/v0.6.7`, { headers })).json()
        if (release.assets) {
          console.log(`  release: ${release.html_url}`)
          for (const asset of release.assets) console.log(`    ${asset.name} ${(asset.size / 1048576).toFixed(1)} MB`)
        } else {
          console.log('  release:', release.message)
        }
        process.exitCode = run.conclusion === 'success' ? 0 : 1
        return
      }
    } else {
      console.log(`[${new Date().toISOString()}] run not listed yet`)
    }
    await sleep(30_000)
  }
  console.log('gave up waiting')
  process.exitCode = 1
})()
