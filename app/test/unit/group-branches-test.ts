import { describe, it } from 'node:test'
import assert from 'node:assert'
import { groupBranches } from '../../src/ui/branches'
import { Branch, BranchType } from '../../src/models/branch'
import { CommitIdentity } from '../../src/models/commit-identity'

describe('Branches grouping', () => {
  const author = new CommitIdentity('Hubot', 'hubot@github.com', new Date())

  const branchTip = {
    sha: '300acef',
    author,
  }

  const currentBranch = new Branch(
    'master',
    null,
    branchTip,
    BranchType.Local,
    ''
  )
  const defaultBranch = new Branch(
    'master',
    null,
    branchTip,
    BranchType.Local,
    ''
  )
  const recentBranches = [
    new Branch('some-recent-branch', null, branchTip, BranchType.Local, ''),
  ]
  const otherBranch = new Branch(
    'other-branch',
    null,
    branchTip,
    BranchType.Local,
    ''
  )

  const allBranches = [currentBranch, ...recentBranches, otherBranch]

  const local = (name: string) =>
    new Branch(name, null, branchTip, BranchType.Local, `refs/heads/${name}`)

  const remote = (name: string) =>
    new Branch(
      `origin/${name}`,
      null,
      branchTip,
      BranchType.Remote,
      `refs/remotes/origin/${name}`
    )

  it('should group branches', () => {
    const groups = groupBranches(
      defaultBranch,
      currentBranch,
      allBranches,
      recentBranches
    )
    assert.equal(groups.length, 3)

    assert.equal(groups[0].identifier, 'default')
    let items = groups[0].items
    assert.equal(items[0].branch, defaultBranch)

    assert.equal(groups[1].identifier, 'recent')
    items = groups[1].items
    assert.equal(items[0].branch, recentBranches[0])

    assert.equal(groups[2].identifier, 'other')
    items = groups[2].items
    assert.equal(items[0].branch, otherBranch)
  })

  /**
   * The release in flight, reachable in one step.
   *
   * A repository carrying several cycles' branches — they are not always deleted
   * when a release ships — should offer the newest, and it has to compare as a
   * version rather than as text: `1.2026.9` sorts after `1.2026.19` as a string,
   * which would name the wrong release for the fortnight a cycle spends in
   * single digits.
   */
  describe('the current release branch', () => {
    it('picks the newest release branch, numerically', () => {
      const releases = [
        local('release/1.2026.9'),
        local('release/1.2026.19'),
        local('release/1.2026.18'),
      ]

      const groups = groupBranches(
        defaultBranch,
        currentBranch,
        [...allBranches, ...releases],
        recentBranches
      )

      const release = groups.find(g => g.identifier === 'release')

      assert.equal(release?.items.length, 1)
      assert.equal(release?.items[0].branch.name, 'release/1.2026.19')
    })

    it('sits between the recent branches and everything else', () => {
      const groups = groupBranches(
        defaultBranch,
        currentBranch,
        [...allBranches, local('release/1.2026.19')],
        recentBranches
      )

      assert.deepStrictEqual(
        groups.map(g => g.identifier),
        ['default', 'recent', 'release', 'other']
      )
    })

    it('is left out of the other branches, so it appears once', () => {
      const releaseBranch = local('release/1.2026.19')

      const groups = groupBranches(
        defaultBranch,
        currentBranch,
        [...allBranches, releaseBranch],
        recentBranches
      )

      const other = groups.find(g => g.identifier === 'other')

      assert.ok(
        other?.items.every(i => i.branch.name !== releaseBranch.name),
        'the release branch should not also be listed under other branches'
      )
    })

    it('is left out of the recent branches, so it appears once', () => {
      const releaseBranch = local('release/1.2026.19')

      const groups = groupBranches(
        defaultBranch,
        currentBranch,
        [...allBranches, releaseBranch],
        [...recentBranches, releaseBranch]
      )

      const recent = groups.find(g => g.identifier === 'recent')

      assert.ok(
        recent?.items.every(i => i.branch.name !== releaseBranch.name),
        'the release branch should not also be listed under recent branches'
      )
    })

    /**
     * A release fetched but never checked out is still a release in flight, and
     * still worth one click.
     */
    it('takes a remote release branch when there is no local one', () => {
      const groups = groupBranches(
        defaultBranch,
        currentBranch,
        [...allBranches, remote('release/1.2026.19')],
        recentBranches
      )

      const release = groups.find(g => g.identifier === 'release')

      assert.equal(release?.items[0].branch.name, 'origin/release/1.2026.19')
    })

    /** Where both copies exist, checking out lands on the local one. */
    it('prefers the local copy of the same release', () => {
      const groups = groupBranches(
        defaultBranch,
        currentBranch,
        [
          ...allBranches,
          remote('release/1.2026.19'),
          local('release/1.2026.19'),
        ],
        recentBranches
      )

      const release = groups.find(g => g.identifier === 'release')

      assert.equal(release?.items[0].branch.name, 'release/1.2026.19')
      assert.equal(release?.items[0].branch.type, BranchType.Local)
    })

    it('prefers a newer remote release over an older local one', () => {
      const groups = groupBranches(
        defaultBranch,
        currentBranch,
        [
          ...allBranches,
          local('release/1.2026.18'),
          remote('release/1.2026.19'),
        ],
        recentBranches
      )

      const release = groups.find(g => g.identifier === 'release')

      assert.equal(release?.items[0].branch.name, 'origin/release/1.2026.19')
    })

    it('has no group at all when nothing is on a release branch', () => {
      const groups = groupBranches(
        defaultBranch,
        currentBranch,
        allBranches,
        recentBranches
      )

      assert.equal(
        groups.find(g => g.identifier === 'release'),
        undefined
      )
    })

    /**
     * A branch called `release/nonsense` is not a release. It stays under other
     * branches rather than being promoted to a shortcut for a release that does
     * not exist.
     */
    it('ignores a release branch with no version in its name', () => {
      const groups = groupBranches(
        defaultBranch,
        currentBranch,
        [...allBranches, local('release/nonsense')],
        recentBranches
      )

      assert.equal(
        groups.find(g => g.identifier === 'release'),
        undefined
      )

      const other = groups.find(g => g.identifier === 'other')

      assert.ok(other?.items.some(i => i.branch.name === 'release/nonsense'))
    })
  })
})
