import { describe, it } from 'node:test'
import assert from 'node:assert'
import { describeFinishReleaseCommands } from '../../../src/lib/hotflow/actions'
import { Branch, BranchType } from '../../../src/models/branch'
import { IReleaseBranchState } from '../../../src/models/hotflow'
import { parseReleaseVersion } from '../../../src/lib/hotflow/version'

function release(version: string = '1.2026.19'): IReleaseBranchState {
  const parsed = parseReleaseVersion(version)

  assert.ok(parsed !== null, `${version} should parse`)

  return {
    branch: new Branch(
      `release/${version}`,
      null,
      // A tip is a sha and nothing else — the older tests carry an author here,
      // which the type has never had and only survives excess-property checking
      // because it reaches the constructor through a variable.
      { sha: '300acef' },
      BranchType.Local,
      `refs/heads/release/${version}`
    ),
    version: parsed,
    releaseSequence: null,
    commits: [],
    releaseOnlyCommits: [],
    incomingCommits: [],
    aheadOfProduction: 4,
    behindIntegration: 0,
    vsoNumbers: [],
    contributorCount: 1,
    verdict: 'ready',
  }
}

/**
 * The preview is a promise about what will run, so the flag it shows and the
 * flag the merge uses have to be the same one. This covers the showing half; the
 * doing half is one argument in `_finishRelease`.
 */
describe('hotflow/describeFinishReleaseCommands', () => {
  const merge = (commands: ReadonlyArray<string>) =>
    commands.filter(c => c.startsWith('git merge'))

  it('leaves the merge bare by default, so git decides', () => {
    const commands = describeFinishReleaseCommands(
      release(),
      'main',
      'develop',
      false
    )

    assert.deepStrictEqual(merge(commands), ['git merge release/1.2026.19'])
  })

  it('adds --no-ff only when asked', () => {
    const commands = describeFinishReleaseCommands(
      release(),
      'main',
      'develop',
      false,
      false,
      true
    )

    assert.deepStrictEqual(merge(commands), [
      'git merge release/1.2026.19 --no-ff',
    ])
  })

  /**
   * The choice is about the release landing in production. Merging back into
   * development is housekeeping, and forcing a merge commit there was never
   * what the flag meant.
   */
  it('does not spread --no-ff to the merge back into development', () => {
    const commands = describeFinishReleaseCommands(
      release(),
      'main',
      'develop',
      true,
      false,
      true
    )

    assert.deepStrictEqual(merge(commands), [
      'git merge release/1.2026.19 --no-ff',
      'git merge release/1.2026.19',
    ])
  })

  it('still names the branch, the tag and the push', () => {
    const commands = describeFinishReleaseCommands(
      release(),
      'main',
      'develop',
      false
    )

    assert.deepStrictEqual(commands, [
      'git checkout main',
      'git pull origin main',
      'git merge release/1.2026.19',
      'git tag -a -m "" 1.2026.19',
      'git push origin main --follow-tags',
    ])
  })
})
