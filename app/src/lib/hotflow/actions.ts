import { Branch, BranchType } from '../../models/branch'
import { Commit } from '../../models/commit'
import { IHotFlowState, IReleaseBranchState } from '../../models/hotflow'
import { IRepositoryProvider } from './repository-provider'

/**
 * Pre-flight checks for the HotFlow actions.
 *
 * Every action shows its checks before it runs. Blocking checks disable the
 * confirm button; warnings are shown but let you proceed. The point is that you
 * can see *why* an operation is safe rather than trusting that it is.
 *
 * Branch names are always taken from the resolved state, never assumed — repos
 * disagree about whether integration is `develop`, `development` or `dev`.
 */

export interface IPreflightCheck {
  /** Stable id, so the UI can key rows without relying on the label. */
  readonly id: string

  /** What was checked, in plain language. */
  readonly label: string

  readonly status: 'pass' | 'warn' | 'fail'

  /** Shown under the label when there's something to explain. */
  readonly detail?: string

  /** Blocking failures prevent the action entirely. */
  readonly blocking: boolean
}

export interface IPreflightResult {
  readonly checks: ReadonlyArray<IPreflightCheck>

  /** True when nothing blocking failed. */
  readonly canProceed: boolean
}

/**
 * How many production-only commits to read before giving up counting.
 *
 * The number is only ever shown, and "more than twenty" and "eighty" call for
 * the same response, so there's no reason to walk a long history to tell them
 * apart.
 */
const MaxStrandedCommits = 20

/**
 * The ref to measure a shared branch by: its remote counterpart when it has one.
 *
 * A remote branch is already the remote. A local one is only as current as the
 * last pull, and every question here is about what everyone has rather than what
 * this working copy happens to hold.
 */
function remotePreferredRef(branch: Branch): string {
  return branch.upstream ?? branch.name
}

/**
 * Names the first couple of stranded commits, so the warning points somewhere
 * rather than just asserting a number.
 */
function describeStranded(commits: ReadonlyArray<Commit>): string {
  const named = commits
    .slice(0, 2)
    .map(c => `${c.shortSha} ${c.summary}`)
    .join(', ')

  return named.length === 0 ? '' : ` — ${named}`
}

function summarise(checks: ReadonlyArray<IPreflightCheck>): IPreflightResult {
  return {
    checks,
    canProceed: !checks.some(c => c.status === 'fail' && c.blocking),
  }
}

/**
 * The working-directory check, or nothing at all.
 *
 * Without a working copy this isn't a check that fails — it's a question that
 * stops existing, so it produces no row rather than a row that passes for the
 * wrong reason. `blocking` differs by action, hence the parameter.
 */
async function workingTreeCheck(
  provider: IRepositoryProvider,
  blocking: boolean,
  detailWhenDirty: string
): Promise<IPreflightCheck | null> {
  const clean = await provider.isWorkingTreeClean()

  if (clean === null) {
    return null
  }

  return {
    id: 'clean-tree',
    label: 'Working directory is clean',
    status: clean ? 'pass' : blocking ? 'fail' : 'warn',
    detail: clean ? undefined : detailWhenDirty,
    blocking,
  }
}

/**
 * The branch a new one is being cut from.
 *
 * Passed in rather than read off the state because it isn't always the
 * integration branch: a hotfix starts from the release in flight, so that it
 * carries what is being tested rather than everything unreleased on develop.
 */
export interface IStartBranchBase {
  /** How to refer to it, for the check's label. */
  readonly name: string

  /** The resolved branch, or null when the repository hasn't got it. */
  readonly branch: Branch | null
}

/**
 * Checks for starting a branch off another one.
 *
 * Defaults to the integration branch, which is where a feature and a release
 * both start.
 */
export async function preflightStartBranch(
  provider: IRepositoryProvider,
  hotFlowState: IHotFlowState,
  branchName: string,
  existingBranches: ReadonlyArray<Branch>,
  base?: IStartBranchBase
): Promise<IPreflightResult> {
  const checks: Array<IPreflightCheck> = []
  const resolvedBase: IStartBranchBase = base ?? {
    name: hotFlowState.integrationBranchName,
    branch: hotFlowState.integrationBranch,
  }

  const tree = await workingTreeCheck(
    provider,
    false,
    'Uncommitted changes will be carried onto the new branch.'
  )

  if (tree !== null) {
    checks.push(tree)
  }

  const hasBase = resolvedBase.branch !== null
  checks.push({
    id: 'base-exists',
    label: `${resolvedBase.name} exists`,
    status: hasBase ? 'pass' : 'fail',
    detail: hasBase
      ? undefined
      : `This branch would be cut from ${resolvedBase.name}, which this repository doesn't have.`,
    blocking: true,
  })

  const nameTaken = existingBranches.some(
    b => b.nameWithoutRemote === branchName
  )
  checks.push({
    id: 'name-available',
    label: 'Branch name is available',
    status: nameTaken ? 'fail' : 'pass',
    detail: nameTaken
      ? `A branch named ${branchName} already exists.`
      : undefined,
    blocking: true,
  })

  return summarise(checks)
}

/** Additional check for starting a release: the tag mustn't already exist. */
export async function preflightStartRelease(
  provider: IRepositoryProvider,
  hotFlowState: IHotFlowState,
  version: string,
  branchName: string,
  existingBranches: ReadonlyArray<Branch>
): Promise<IPreflightResult> {
  const base = await preflightStartBranch(
    provider,
    hotFlowState,
    branchName,
    existingBranches
  )

  const tags = await provider.getAllTagNames()
  const tagExists = tags.has(version)

  const checks = [
    ...base.checks,
    {
      id: 'tag-available',
      label: `No existing tag ${version}`,
      status: tagExists ? ('fail' as const) : ('pass' as const),
      detail: tagExists
        ? `${version} has already shipped. Pick a version that hasn't been tagged.`
        : undefined,
      blocking: true,
    },
  ]

  return summarise(checks)
}

/**
 * Checks for merging the integration branch into the current release branch.
 */
export async function preflightUpdateRelease(
  provider: IRepositoryProvider,
  release: IReleaseBranchState,
  integrationBranch: Branch,
  fastForwardOnly: boolean
): Promise<IPreflightResult> {
  const checks: Array<IPreflightCheck> = []
  const integrationName = integrationBranch.nameWithoutRemote

  const tree = await workingTreeCheck(
    provider,
    true,
    'Commit or stash your changes before merging.'
  )

  if (tree !== null) {
    checks.push(tree)
  }

  const hasWork = release.behindIntegration > 0
  checks.push({
    id: 'has-drift',
    label: `Behind ${integrationName}`,
    status: hasWork ? 'pass' : 'warn',
    detail: hasWork
      ? `${release.behindIntegration} commits will be merged in.`
      : 'This release is already up to date — there is nothing to merge.',
    blocking: false,
  })

  // A merge base tells us the two branches are actually related. Without one, a
  // merge would produce something nobody wants.
  const mergeBase = await provider.getMergeBase(
    release.branch.name,
    integrationBranch.name
  )

  checks.push({
    id: 'related',
    label: 'Branches share history',
    status: mergeBase === null ? 'fail' : 'pass',
    detail:
      mergeBase === null
        ? `${release.branch.name} and ${integrationBranch.name} have no common ancestor.`
        : undefined,
    blocking: true,
  })

  // A fast-forward is only possible while everything on the release is already on
  // the integration branch — which is exactly what "the merge base is the release
  // tip" says. Checked here rather than left to git so the dialog can say no
  // before the fetch and checkout, instead of after them.
  if (fastForwardOnly) {
    const canFastForward =
      mergeBase !== null && mergeBase === release.branch.tip.sha

    checks.push({
      id: 'can-fast-forward',
      label: 'Release has no commits of its own',
      status: canFastForward ? 'pass' : 'fail',
      detail: canFastForward
        ? undefined
        : `${release.branch.nameWithoutRemote} has commits that aren't on ` +
          `${integrationName}, so it can't be fast-forwarded. Merge instead, or ` +
          `merge the release back into ${integrationName} first.`,
      blocking: true,
    })
  }

  return summarise(checks)
}

/**
 * Commits sitting on production that the integration branch hasn't got.
 *
 * Should always be empty. Everything reaches production through a release, and
 * every release goes back into integration, so integration already holds it —
 * which is why merging production back into integration is expected to change
 * nothing. When this isn't empty, something was committed straight onto
 * production and never carried back, and it is missing from integration and from
 * every release cut since.
 *
 * Merge commits are excluded, and that is what makes this usable rather than
 * noise. Production always carries merge commits integration lacks — including
 * the one a release is about to create — so counting them would report a problem
 * on every release and mean nothing. AmadeusWebApi is exactly that shape: one
 * commit ahead, none once merges are dropped.
 *
 * Both sides are read from the remote where there is one, because the question is
 * what the team has rather than what this working copy last pulled. NimbleObt
 * reported 40 against its local develop, 63 behind at the time, and 18 against
 * origin/develop; the other 22 had been pushed long ago.
 *
 * Shared by the pre-flight warning and by the repair step that follows a release,
 * so the two cannot disagree about whether there is anything to repair.
 */
export async function findCommitsStrandedOnProduction(
  provider: IRepositoryProvider,
  integrationBranch: Branch,
  productionBranch: Branch
): Promise<ReadonlyArray<Commit>> {
  const productionOnly = await provider.getCommitRange(
    remotePreferredRef(integrationBranch),
    remotePreferredRef(productionBranch),
    MaxStrandedCommits
  )

  return productionOnly.filter(c => !c.isMergeCommit)
}

/**
 * Checks for the one action that writes to production.
 *
 * This is deliberately the strictest set in HotFlow: it merges into the
 * production branch, creates a tag other people depend on, and pushes both.
 */
export async function preflightFinishRelease(
  provider: IRepositoryProvider,
  release: IReleaseBranchState,
  productionBranch: Branch,

  /**
   * The resolved integration branch, not just its name — the back-merge check
   * below reads a commit range against it, and a name won't resolve when
   * integration is remote-only.
   */
  integrationBranch: Branch,
  missingWorkItemCount: number
): Promise<IPreflightResult> {
  const integrationName = integrationBranch.nameWithoutRemote
  const checks: Array<IPreflightCheck> = []
  const productionName = productionBranch.nameWithoutRemote

  const tree = await workingTreeCheck(
    provider,
    true,
    'Commit or stash your changes first.'
  )

  if (tree !== null) {
    checks.push(tree)
  }

  // Shipping a release that's behind integration means shipping stale code.
  const isBehind = release.behindIntegration > 0
  checks.push({
    id: 'not-behind',
    label: `Not behind ${integrationName}`,
    status: isBehind ? 'fail' : 'pass',
    detail: isBehind
      ? `${release.behindIntegration} commits are in ${integrationName} but not this release. Update it first, or override below.`
      : undefined,
    blocking: true,
  })

  // Local production must match its remote, or the merge lands on a stale base.
  // Without a working copy there is no local production to be stale, so the
  // question is skipped rather than answered.
  // Skipped when production is a remote branch, which it is in any repository
  // with no local `main` — three of the four surveyed. There is then no local copy
  // that could be out of step with the remote, so "is it in sync" isn't a question
  // that fails, it's one that stops existing; the same reasoning as the working
  // directory check above.
  //
  // It used to fail instead, reporting that main "isn't tracking a remote branch"
  // — true of `origin/main` and entirely beside the point — and blocking the
  // release. Fetching couldn't clear it, because staleness was never the problem;
  // checking main out did, by creating the local branch the check was looking for.
  // Finishing works either way: the release checks production out first, which
  // creates that local branch anyway.
  if (provider.hasWorkingCopy && productionBranch.type !== BranchType.Remote) {
    const productionAheadBehind = await provider.getUpstreamDivergence(
      productionBranch
    )

    const productionInSync =
      productionAheadBehind !== null &&
      productionAheadBehind.ahead === 0 &&
      productionAheadBehind.behind === 0

    checks.push({
      id: 'production-in-sync',
      label: `${productionName} matches its remote`,
      status: productionInSync ? 'pass' : 'fail',
      detail: productionInSync
        ? undefined
        : productionAheadBehind === null
        ? `${productionName} isn't tracking a remote branch.`
        : `${productionName} is ${productionAheadBehind.ahead} ahead and ${productionAheadBehind.behind} behind its remote. Fetch and reconcile first.`,
      blocking: true,
    })
  }

  // Whether the back-merge after this will be the no-op it is supposed to be.
  //
  // Finishing a release merges it into production and merges it back into
  // integration, which leaves integration holding everything the release had. The
  // remaining question is the other direction: does production hold anything
  // integration doesn't? It shouldn't. Everything reaches production *through* a
  // release, and every release goes back into integration.
  //
  // When it isn't empty, something was committed straight onto production — a
  // hotfix applied under pressure and never carried back is the usual story — and
  // that work is missing from integration and from every release cut after it. It
  // will stay missing, silently, because nothing else looks.
  //
  // Merge commits are excluded deliberately. Production always carries merge
  // commits integration lacks, including the one this very release is about to
  // create, so counting them would make this warn every single time and mean
  // nothing. What matters is whether real work is stranded.
  const stranded = await findCommitsStrandedOnProduction(
    provider,
    integrationBranch,
    productionBranch
  )

  checks.push({
    id: 'production-merged-back',
    label: `${productionName} is contained in ${integrationName}`,
    status: stranded.length === 0 ? 'pass' : 'warn',
    detail:
      stranded.length === 0
        ? undefined
        : `${stranded.length} ${
            stranded.length === 1 ? 'commit is' : 'commits are'
          } on ${productionName} but not on ${integrationName}` +
          `${describeStranded(
            stranded
          )}. Merging ${productionName} back into ` +
          `${integrationName} should change nothing; here it would bring work ` +
          `across, so that work is missing from ${integrationName} and from every ` +
          `release cut since. Shipping this release is still safe — the gap is ` +
          `in ${integrationName}, not here.`,
    blocking: false,
  })

  const tags = await provider.getAllTagNames()
  const tagExists = tags.has(release.version.raw)
  checks.push({
    id: 'tag-available',
    label: `No existing tag ${release.version.raw}`,
    status: tagExists ? 'fail' : 'pass',
    detail: tagExists
      ? `${release.version.raw} is already tagged. This release may have shipped already.`
      : undefined,
    blocking: true,
  })

  const hasSomethingToShip = release.aheadOfProduction > 0
  checks.push({
    id: 'has-commits',
    label: `Ahead of ${productionName}`,
    status: hasSomethingToShip ? 'pass' : 'fail',
    detail: hasSomethingToShip
      ? `${release.aheadOfProduction} commits will ship.`
      : `There is nothing in this release that isn't already in ${productionName}.`,
    blocking: true,
  })

  // Non-blocking, because only the person shipping knows whether the missing
  // items matter — but they must see it.
  if (missingWorkItemCount > 0) {
    checks.push({
      id: 'work-items-missing',
      label: 'Work items assigned to this release are missing',
      status: 'warn',
      detail: `${missingWorkItemCount} work items are assigned to this release but aren't in it.`,
      blocking: false,
    })
  }

  return summarise(checks)
}

/**
 * The exact git commands an action will run.
 *
 * Shown in the dialog and available to copy, because trust in a tool that writes
 * to the production branch comes from showing the work rather than hiding it.
 */
export function describeFinishReleaseCommands(
  release: IReleaseBranchState,
  productionName: string,
  integrationName: string,
  mergeBackIntoIntegration: boolean,

  /**
   * Whether production holds work integration doesn't, so the repair step runs.
   *
   * Absent from the preview when there is nothing stranded, which is the ordinary
   * case — a step that does nothing shouldn't be advertised as part of shipping.
   */
  catchIntegrationUp: boolean = false,

  /**
   * Whether to record the merge even where it could fast-forward.
   *
   * Off by default, which leaves the command bare and lets git decide, the same
   * as typing it yourself would. It used to be on and unconditional, so every
   * release landed as a merge commit whether or not there was anything to merge.
   */
  noFastForward: boolean = false
): ReadonlyArray<string> {
  const releaseRef = release.branch.nameWithoutRemote
  const version = release.version.raw

  const commands = [
    `git checkout ${productionName}`,
    `git pull origin ${productionName}`,
    `git merge ${releaseRef}${noFastForward ? ' --no-ff' : ''}`,
    `git tag -a -m "" ${version}`,
    `git push origin ${productionName} --follow-tags`,
  ]

  if (mergeBackIntoIntegration) {
    commands.push(
      `git checkout ${integrationName}`,
      `git merge ${releaseRef}`,
      `git push origin ${integrationName}`
    )
  }

  if (catchIntegrationUp) {
    // Already on the integration branch by this point when the back-merge ran;
    // the checkout is repeated for the case where it didn't.
    commands.push(
      `git checkout ${integrationName}`,
      `git merge ${productionName}`,
      `git push origin ${integrationName}`
    )
  }

  return commands
}

/**
 * The commands for updating a release from the integration branch.
 *
 * `mergeRef` is passed rather than rebuilt from `integrationName` because this
 * preview is a promise about what will run, and it drifted from reality once
 * already — it claimed a fetch and a push that didn't happen, and an
 * `origin/`-prefixed merge when the local branch was being merged. The caller
 * hands over the ref it's actually going to use.
 */
export function describeUpdateReleaseCommands(
  release: IReleaseBranchState,
  mergeRef: string,
  fastForwardOnly: boolean
): ReadonlyArray<string> {
  const branchName = release.branch.nameWithoutRemote

  return [
    `git fetch origin`,
    `git checkout ${branchName}`,
    fastForwardOnly
      ? `git merge --ff-only ${mergeRef}`
      : `git merge ${mergeRef}`,
    `git push origin ${branchName}`,
  ]
}

/**
 * The commands for cutting a new branch off another one.
 *
 * `startRef` is the ref that will actually be handed to `git checkout`, rather
 * than a branch name this rebuilds an `origin/` prefix onto — a hotfix starts
 * from a release branch, and a repository without a remote counterpart starts
 * from the local branch, so the prefix isn't ours to assume.
 *
 * `--no-track` is load-bearing and shown because of it. Without it the new branch
 * tracks `origin/develop`, and its first push aims at develop rather than at
 * itself — which is how a feature branch came to be rejected by branch protection
 * with `feature/107958-… -> develop`.
 */
export function describeStartBranchCommands(
  branchName: string,
  startRef: string
): ReadonlyArray<string> {
  return [
    `git fetch origin`,
    `git checkout -b ${branchName} --no-track ${startRef}`,
  ]
}
