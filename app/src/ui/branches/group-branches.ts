import { Branch, BranchType } from '../../models/branch'
import { parseReleaseBranchName } from '../../lib/hotflow/branch-patterns'
import { compareReleaseVersions } from '../../lib/hotflow/version'
import { IReleaseVersion } from '../../models/hotflow'
import { IFilterListGroup, IFilterListItem } from '../lib/filter-list'

export type BranchGroupIdentifier = 'default' | 'recent' | 'release' | 'other'

export interface IBranchListItem extends IFilterListItem {
  readonly text: ReadonlyArray<string>
  readonly id: string
  readonly branch: Branch
}

/**
 * The release branch this repository is currently shipping.
 *
 * The newest one, always — deliberately not whatever release the HotFlow view is
 * showing. That defaults to the latest but can be wound back to an older cycle,
 * and a branch list that followed it would quietly start offering last month's
 * release to check out because somebody was reading about it.
 *
 * Both copies of a release count: a repository that has fetched
 * `origin/release/1.2026.19` without checking it out still has that release in
 * flight, and it is a branch worth reaching in one step. Where both exist the
 * local one wins, because that is the one checking out would land on.
 */
function findCurrentReleaseBranch(
  branches: ReadonlyArray<Branch>
): Branch | null {
  let best: { branch: Branch; version: IReleaseVersion } | null = null

  for (const branch of branches) {
    if (branch.isDesktopForkRemoteBranch) {
      continue
    }

    const version = parseReleaseBranchName(branch.name)

    if (version === null) {
      continue
    }

    if (best === null) {
      best = { branch, version }
      continue
    }

    const comparison = compareReleaseVersions(version, best.version)

    const preferLocal =
      comparison === 0 &&
      branch.type === BranchType.Local &&
      best.branch.type !== BranchType.Local

    if (comparison > 0 || preferLocal) {
      best = { branch, version }
    }
  }

  return best === null ? null : best.branch
}

export function groupBranches(
  defaultBranch: Branch | null,
  currentBranch: Branch | null,
  allBranches: ReadonlyArray<Branch>,
  recentBranches: ReadonlyArray<Branch>
): ReadonlyArray<IFilterListGroup<IBranchListItem>> {
  const groups = new Array<IFilterListGroup<IBranchListItem>>()

  if (defaultBranch) {
    groups.push({
      identifier: 'default',
      items: [
        {
          text: [defaultBranch.name],
          id: defaultBranch.name,
          branch: defaultBranch,
        },
      ],
    })
  }

  const recentBranchNames = new Set<string>()
  const defaultBranchName = defaultBranch ? defaultBranch.name : null

  /*
   * Left out of its own group when it is already the default branch, which no
   * repository here does but a repository could. Two entries for one branch is
   * worse than a missing shortcut.
   */
  const releaseBranch = findCurrentReleaseBranch(allBranches)
  const releaseBranchName =
    releaseBranch === null || releaseBranch.name === defaultBranchName
      ? null
      : releaseBranch.name

  const recentBranchesWithoutDefault = recentBranches.filter(
    // Also without the release branch: it has a group of its own directly below,
    // the same reason the default branch is filtered out here.
    b => b.name !== defaultBranchName && b.name !== releaseBranchName
  )
  if (recentBranchesWithoutDefault.length > 0) {
    const recentBranches = new Array<IBranchListItem>()

    for (const branch of recentBranchesWithoutDefault) {
      recentBranches.push({
        text: [branch.name],
        id: branch.name,
        branch,
      })
      recentBranchNames.add(branch.name)
    }

    groups.push({
      identifier: 'recent',
      items: recentBranches,
    })
  }

  if (releaseBranch !== null && releaseBranchName !== null) {
    groups.push({
      identifier: 'release',
      items: [
        {
          text: [releaseBranch.name],
          id: releaseBranch.name,
          branch: releaseBranch,
        },
      ],
    })
  }

  const remainingBranches = allBranches.filter(
    b =>
      b.name !== defaultBranchName &&
      b.name !== releaseBranchName &&
      !recentBranchNames.has(b.name) &&
      !b.isDesktopForkRemoteBranch
  )

  const remainingItems = remainingBranches.map(b => ({
    text: [b.name],
    id: b.name,
    branch: b,
  }))
  groups.push({
    identifier: 'other',
    items: remainingItems,
  })

  return groups
}
