import * as React from 'react'
import { Repository } from '../../../models/repository'
import { Dispatcher } from '../../dispatcher'
import { IHotFlowState } from '../../../models/hotflow'
import { Dialog, DialogContent, DialogError, DialogFooter } from '../../dialog'
import { OkCancelButtonGroup } from '../../dialog/ok-cancel-button-group'
import { Ref } from '../../lib/ref'
import { TextBox } from '../../lib/text-box'
import { Checkbox, CheckboxValue } from '../../lib/checkbox'
import {
  IPreflightCheck,
  describeFinishReleaseCommands,
  preflightFinishRelease,
} from '../../../lib/hotflow/actions'
import { GitRepositoryProvider } from '../../../lib/hotflow/git-repository-provider'
import { PreflightChecks } from './preflight-checks'
import { CommandPreview } from './command-preview'

interface IFinishReleaseDialogProps {
  readonly repository: Repository
  readonly dispatcher: Dispatcher
  readonly hotFlowState: IHotFlowState

  /** Work items tagged for the cycle but absent from the release branch. */
  readonly missingWorkItemCount: number

  readonly onDismissed: () => void
}

interface IFinishReleaseDialogState {
  readonly typedVersion: string
  readonly mergeBack: boolean
  readonly noFastForward: boolean
  readonly overrideBehind: boolean
  readonly checks: ReadonlyArray<IPreflightCheck>
  readonly isChecking: boolean
  readonly isFinishing: boolean
}

/**
 * Finish a release: merge into production, tag it, push both.
 *
 * This is the only HotFlow action that writes to `main` and creates a tag other
 * people depend on, so it's deliberately the most guarded thing in the feature —
 * blocking pre-flight checks, a typed version confirmation, and nothing that
 * force-pushes, force-tags, or deletes.
 */
export class FinishReleaseDialog extends React.Component<
  IFinishReleaseDialogProps,
  IFinishReleaseDialogState
> {
  public constructor(props: IFinishReleaseDialogProps) {
    super(props)

    const release = props.hotFlowState.currentRelease

    this.state = {
      typedVersion: '',
      // Checked by default when there's something that would otherwise be
      // orphaned on production — forgetting is how a hotfix gets lost.
      mergeBack: (release?.releaseOnlyCommits.length ?? 0) > 0,

      // Off, so the command runs bare and git decides. Per dialog rather than
      // remembered: it is a property of the release being shipped, not a
      // preference, and the preview above the button says which one it is.
      noFastForward: false,
      overrideBehind: false,
      checks: [],
      isChecking: true,
      isFinishing: false,
    }
  }

  public componentDidMount() {
    this.runChecks()
  }

  private get integrationName(): string {
    return this.props.hotFlowState.integrationBranchName
  }

  private get productionName(): string {
    return this.props.hotFlowState.productionBranchName
  }

  /**
   * Whether the pre-flight found work stranded on production.
   *
   * Read back off the check rather than kept as its own state, so the extra step
   * shown in the preview and the one the release actually runs are decided by the
   * same answer. Invisible when there's nothing stranded, which is the ordinary
   * case — a step that would do nothing has no business being advertised as part
   * of shipping.
   */
  private get hasStrandedCommits(): boolean {
    return this.state.checks.some(
      c => c.id === 'production-merged-back' && c.status === 'warn'
    )
  }

  private async runChecks() {
    const { repository, hotFlowState, missingWorkItemCount } = this.props
    const release = hotFlowState.currentRelease
    const productionBranch = hotFlowState.productionBranch
    const integrationBranch = hotFlowState.integrationBranch

    if (
      release === null ||
      productionBranch === null ||
      integrationBranch === null
    ) {
      this.setState({ isChecking: false })
      return
    }

    const result = await preflightFinishRelease(
      new GitRepositoryProvider(repository),
      release,
      productionBranch,
      integrationBranch,
      missingWorkItemCount
    )

    // Only `checks` is stored: whether we can proceed is derived from it, so
    // that the behind-integration override can be applied at read time.
    this.setState({ checks: result.checks, isChecking: false })
  }

  /**
   * The behind-integration check is the one failure we let you override, because
   * occasionally you genuinely do want to ship what's on the branch. Everything
   * else stays blocking.
   */
  private get effectiveCanProceed(): boolean {
    const { checks, overrideBehind } = this.state

    const blockingFailures = checks.filter(
      c => c.status === 'fail' && c.blocking
    )

    if (blockingFailures.length === 0) {
      return true
    }

    return overrideBehind && blockingFailures.every(c => c.id === 'not-behind')
  }

  private get isBehindOverridable(): boolean {
    return this.state.checks.some(
      c => c.id === 'not-behind' && c.status === 'fail'
    )
  }

  public render() {
    const { hotFlowState } = this.props
    const release = hotFlowState.currentRelease

    if (release === null) {
      return (
        <Dialog
          id="hotflow-finish-release"
          title={__DARWIN__ ? 'Finish Release' : 'Finish release'}
          onDismissed={this.props.onDismissed}
          onSubmit={this.props.onDismissed}
        >
          <DialogError>
            There's no release branch to finish in this repository.
          </DialogError>
          <DialogFooter>
            <OkCancelButtonGroup
              okButtonText="Close"
              cancelButtonVisible={false}
            />
          </DialogFooter>
        </Dialog>
      )
    }

    const version = release.version.raw
    const versionConfirmed = this.state.typedVersion.trim() === version

    const disabled =
      !this.effectiveCanProceed ||
      !versionConfirmed ||
      this.state.isChecking ||
      this.state.isFinishing

    return (
      <Dialog
        id="hotflow-finish-release"
        title={
          __DARWIN__ ? `Finish Release ${version}` : `Finish release ${version}`
        }
        onSubmit={this.onSubmit}
        onDismissed={this.props.onDismissed}
        loading={this.state.isFinishing}
        disabled={this.state.isFinishing}
        type="warning"
      >
        <DialogContent>
          <p className="hotflow-dialog-lede">
            Merges <Ref>{release.branch.nameWithoutRemote}</Ref> into{' '}
            <Ref>{this.productionName}</Ref>, tags it <Ref>{version}</Ref>, and
            pushes both.
          </p>

          <h3 className="hotflow-dialog-heading">Before you ship</h3>
          <PreflightChecks
            checks={this.state.checks}
            isLoading={this.state.isChecking}
          />

          {this.isBehindOverridable && (
            <Checkbox
              label={`Ship anyway, even though it's behind ${this.integrationName}`}
              value={
                this.state.overrideBehind ? CheckboxValue.On : CheckboxValue.Off
              }
              onChange={this.onOverrideBehindChanged}
            />
          )}

          <h3 className="hotflow-dialog-heading">Shipping to production</h3>
          <div className="hotflow-ship-stats">
            <div>
              <span className="hotflow-ship-value num">
                {release.aheadOfProduction}
              </span>
              <span className="hotflow-ship-label">commits</span>
            </div>
            <div>
              <span className="hotflow-ship-value num">
                {release.vsoNumbers.length}
              </span>
              <span className="hotflow-ship-label">work items</span>
            </div>
            <div>
              <span className="hotflow-ship-value num">
                {release.contributorCount}
              </span>
              <span className="hotflow-ship-label">contributors</span>
            </div>
            <div>
              <span className="hotflow-ship-value mono">{version}</span>
              <span className="hotflow-ship-label">new tag</span>
            </div>
          </div>

          {this.renderMergeBack()}

          <Checkbox
            label="No fast forward — land the release as a merge commit"
            value={
              this.state.noFastForward ? CheckboxValue.On : CheckboxValue.Off
            }
            onChange={this.onNoFastForwardChanged}
          />

          <div className="hotflow-confirm">
            <TextBox
              label={`Type ${version} to confirm`}
              value={this.state.typedVersion}
              onValueChanged={this.onTypedVersionChanged}
              placeholder={version}
            />
          </div>

          <CommandPreview
            commands={describeFinishReleaseCommands(
              release,
              this.productionName,
              this.integrationName,
              this.state.mergeBack,
              this.hasStrandedCommits,
              this.state.noFastForward
            )}
          />
        </DialogContent>

        <DialogFooter>
          <OkCancelButtonGroup
            destructive={true}
            okButtonText={
              __DARWIN__ ? `Merge & Tag ${version}` : `Merge and tag ${version}`
            }
            okButtonDisabled={disabled}
          />
        </DialogFooter>
      </Dialog>
    )
  }

  /**
   * The merge-back step, which only appears when there's actually something to
   * merge back. Naming the commits is the point — an unexplained checkbox is a
   * checkbox people tick without reading.
   */
  private renderMergeBack() {
    const release = this.props.hotFlowState.currentRelease

    if (release === null || release.releaseOnlyCommits.length === 0) {
      return null
    }

    const commits = release.releaseOnlyCommits

    return (
      <div className="hotflow-mergeback">
        <Checkbox
          label={`Also merge back into ${this.integrationName}`}
          value={this.state.mergeBack ? CheckboxValue.On : CheckboxValue.Off}
          onChange={this.onMergeBackChanged}
        />
        <div className="hotflow-mergeback-why">
          {commits.length} {commits.length === 1 ? 'commit' : 'commits'} exist
          only on this release branch:
          <ul>
            {commits.slice(0, 4).map(commit => (
              <li key={commit.sha}>
                <span className="mono">{commit.shortSha}</span> {commit.summary}
              </li>
            ))}
            {commits.length > 4 && (
              <li className="dim">and {commits.length - 4} more</li>
            )}
          </ul>
          {!this.state.mergeBack && (
            <p className="hotflow-mergeback-warning">
              Left unchecked, these will only ever exist on{' '}
              {this.productionName}.
            </p>
          )}
        </div>
      </div>
    )
  }

  private onTypedVersionChanged = (typedVersion: string) => {
    this.setState({ typedVersion })
  }

  private onMergeBackChanged = (event: React.FormEvent<HTMLInputElement>) => {
    this.setState({ mergeBack: event.currentTarget.checked })
  }

  private onNoFastForwardChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    this.setState({ noFastForward: event.currentTarget.checked })
  }

  private onOverrideBehindChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    this.setState({ overrideBehind: event.currentTarget.checked })
  }

  private onSubmit = async () => {
    const { repository, dispatcher, hotFlowState } = this.props
    const release = hotFlowState.currentRelease
    const productionBranch = hotFlowState.productionBranch
    const integrationBranch = hotFlowState.integrationBranch

    if (release === null || productionBranch === null) {
      return
    }

    this.setState({ isFinishing: true })

    await dispatcher.finishRelease(
      repository,
      release,
      productionBranch,
      this.state.mergeBack ? integrationBranch : null,
      this.state.noFastForward
    )

    this.props.onDismissed()
  }
}
