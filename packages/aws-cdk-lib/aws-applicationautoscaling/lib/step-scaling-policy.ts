import { Construct } from 'constructs';
import { IScalableTarget } from './scalable-target';
import { AdjustmentType, MetricAggregationType, StepScalingAction } from './step-scaling-action';
import { findAlarmThresholds, normalizeIntervals } from '../../aws-autoscaling-common';
import * as cloudwatch from '../../aws-cloudwatch';
import * as cdk from '../../core';
import { ValidationError } from '../../core/lib/errors';

export interface BasicStepScalingPolicyProps {
  /**
   * Metric to scale on.
   */
  readonly metric: cloudwatch.IMetric;

  /**
   * The intervals for scaling.
   *
   * Maps a range of metric values to a particular scaling behavior.
   *
   * Must be between 2 and 40 steps.
   */
  readonly scalingSteps: ScalingInterval[];

  /**
   * How the adjustment numbers inside 'intervals' are interpreted.
   *
   * @default ChangeInCapacity
   */
  readonly adjustmentType?: AdjustmentType;

  /**
   * Grace period after scaling activity.
   *
   * Subsequent scale outs during the cooldown period are squashed so that only
   * the biggest scale out happens.
   *
   * Subsequent scale ins during the cooldown period are ignored.
   *
   * @see https://docs.aws.amazon.com/autoscaling/application/APIReference/API_StepScalingPolicyConfiguration.html
   * @default No cooldown period
   */
  readonly cooldown?: cdk.Duration;

  /**
   * Minimum absolute number to adjust capacity with as result of percentage scaling.
   *
   * Only when using AdjustmentType = PercentChangeInCapacity, this number controls
   * the minimum absolute effect size.
   *
   * @default No minimum scaling effect
   */
  readonly minAdjustmentMagnitude?: number;

  /**
   * How many evaluation periods of the metric to wait before triggering a scaling action
   *
   * Raising this value can be used to smooth out the metric, at the expense
   * of slower response times.
   *
   * If `datapointsToAlarm` is not set, then all data points in the evaluation period
   * must meet the criteria to trigger a scaling action.
   *
   * @default 1
   */
  readonly evaluationPeriods?: number;

  /**
   * The number of data points out of the evaluation periods that must be breaching to
   * trigger a scaling action
   *
   * Creates an "M out of N" alarm, where this property is the M and the value set for
   * `evaluationPeriods` is the N value.
   *
   * Only has meaning if `evaluationPeriods != 1`.
   *
   * @default - Same as `evaluationPeriods`
   */
  readonly datapointsToAlarm?: number;

  /**
   * Aggregation to apply to all data points over the evaluation periods
   *
   * Only has meaning if `evaluationPeriods != 1`.
   *
   * @default - The statistic from the metric if applicable (MIN, MAX, AVERAGE), otherwise AVERAGE.
   */
  readonly metricAggregationType?: MetricAggregationType;
}

export interface StepScalingPolicyProps extends BasicStepScalingPolicyProps {
  /**
   * The scaling target
   */
  readonly scalingTarget: IScalableTarget;
}

/**
 * Define a scaling strategy which scales depending on absolute values of some metric.
 *
 * You can specify the scaling behavior for various values of the metric.
 *
 * Implemented using one or more CloudWatch alarms and Step Scaling Policies.
 */
export class StepScalingPolicy extends Construct {
  public readonly lowerAlarm?: cloudwatch.Alarm;
  public readonly lowerAction?: StepScalingAction;
  public readonly upperAlarm?: cloudwatch.Alarm;
  public readonly upperAction?: StepScalingAction;

  constructor(scope: Construct, id: string, props: StepScalingPolicyProps) {
    super(scope, id);

    if (props.scalingSteps.length < 2) {
      throw new ValidationError('You must supply at least 2 intervals for autoscaling', scope);
    }

    if (props.scalingSteps.length > 40) {
      throw new ValidationError(`'scalingSteps' can have at most 40 steps, got ${props.scalingSteps.length}`, scope);
    }

    if (props.evaluationPeriods !== undefined && !cdk.Token.isUnresolved(props.evaluationPeriods) && props.evaluationPeriods < 1) {
      throw new ValidationError(`evaluationPeriods cannot be less than 1, got: ${props.evaluationPeriods}`, scope);
    }
    if (props.datapointsToAlarm !== undefined) {
      if (props.evaluationPeriods === undefined) {
        throw new ValidationError('evaluationPeriods must be set if datapointsToAlarm is set', scope);
      }
      if (!cdk.Token.isUnresolved(props.datapointsToAlarm) && props.datapointsToAlarm < 1) {
        throw new ValidationError(`datapointsToAlarm cannot be less than 1, got: ${props.datapointsToAlarm}`, scope);
      }
      if (!cdk.Token.isUnresolved(props.datapointsToAlarm)
        && !cdk.Token.isUnresolved(props.evaluationPeriods)
        && props.evaluationPeriods < props.datapointsToAlarm
      ) {
        throw new ValidationError(`datapointsToAlarm must be less than or equal to evaluationPeriods, got datapointsToAlarm: ${props.datapointsToAlarm}, evaluationPeriods: ${props.evaluationPeriods}`, scope);
      }
    }

    const adjustmentType = props.adjustmentType || AdjustmentType.CHANGE_IN_CAPACITY;
    const changesAreAbsolute = adjustmentType === AdjustmentType.EXACT_CAPACITY;

    const intervals = normalizeIntervals(props.scalingSteps, changesAreAbsolute);
    const alarms = findAlarmThresholds(intervals);

    if (alarms.lowerAlarmIntervalIndex !== undefined) {
      const threshold = intervals[alarms.lowerAlarmIntervalIndex].upper;

      this.lowerAction = new StepScalingAction(this, 'LowerPolicy', {
        adjustmentType,
        cooldown: props.cooldown,
        metricAggregationType: props.metricAggregationType ?? aggregationTypeFromMetric(props.metric),
        minAdjustmentMagnitude: props.minAdjustmentMagnitude,
        scalingTarget: props.scalingTarget,
      });

      for (let i = alarms.lowerAlarmIntervalIndex; i >= 0; i--) {
        this.lowerAction.addAdjustment({
          adjustment: intervals[i].change!,
          lowerBound: i !== 0 ? intervals[i].lower - threshold : undefined, // Extend last interval to -infinity
          upperBound: intervals[i].upper - threshold,
        });
      }

      this.lowerAlarm = new cloudwatch.Alarm(this, 'LowerAlarm', {
        // Recommended by AutoScaling
        metric: props.metric,
        alarmDescription: 'Lower threshold scaling alarm',
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: props.evaluationPeriods ?? 1,
        datapointsToAlarm: props.datapointsToAlarm,
        threshold,
      });
      this.lowerAlarm.addAlarmAction(new StepScalingAlarmAction(this.lowerAction));
    }

    if (alarms.upperAlarmIntervalIndex !== undefined) {
      const threshold = intervals[alarms.upperAlarmIntervalIndex].lower;

      this.upperAction = new StepScalingAction(this, 'UpperPolicy', {
        adjustmentType,
        cooldown: props.cooldown,
        metricAggregationType: props.metricAggregationType ?? aggregationTypeFromMetric(props.metric),
        minAdjustmentMagnitude: props.minAdjustmentMagnitude,
        scalingTarget: props.scalingTarget,
      });

      for (let i = alarms.upperAlarmIntervalIndex; i < intervals.length; i++) {
        this.upperAction.addAdjustment({
          adjustment: intervals[i].change!,
          lowerBound: intervals[i].lower - threshold,
          upperBound: i !== intervals.length - 1 ? intervals[i].upper - threshold : undefined, // Extend last interval to +infinity
        });
      }

      this.upperAlarm = new cloudwatch.Alarm(this, 'UpperAlarm', {
        // Recommended by AutoScaling
        metric: props.metric,
        alarmDescription: 'Upper threshold scaling alarm',
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: props.evaluationPeriods ?? 1,
        datapointsToAlarm: props.datapointsToAlarm,
        threshold,
      });
      this.upperAlarm.addAlarmAction(new StepScalingAlarmAction(this.upperAction));
    }
  }
}

/**
 * A range of metric values in which to apply a certain scaling operation
 */
export interface ScalingInterval {
  /**
   * The lower bound of the interval.
   *
   * The scaling adjustment will be applied if the metric is higher than or equal this value.
   *
   * @default Threshold automatically derived from neighbouring intervals
   */
  readonly lower?: number;

  /**
   * The upper bound of the interval.
   *
   * The scaling adjustment will be applied if the metric is lower than this value.
   *
   * @default Threshold automatically derived from neighbouring intervals
   */
  readonly upper?: number;

  /**
   * The capacity adjustment to apply in this interval
   *
   * The number is interpreted differently based on AdjustmentType:
   *
   * - ChangeInCapacity: add the adjustment to the current capacity.
   *  The number can be positive or negative.
   * - PercentChangeInCapacity: add or remove the given percentage of the current
   *   capacity to itself. The number can be in the range [-100..100].
   * - ExactCapacity: set the capacity to this number. The number must
   *   be positive.
   */
  readonly change: number;
}

function aggregationTypeFromMetric(metric: cloudwatch.IMetric): MetricAggregationType | undefined {
  const statistic = metric.toMetricConfig().metricStat?.statistic;
  if (statistic == null) { return undefined; } // Math expression, don't know aggregation, leave default

  switch (statistic) {
    case 'Average':
      return MetricAggregationType.AVERAGE;
    case 'Minimum':
      return MetricAggregationType.MINIMUM;
    case 'Maximum':
      return MetricAggregationType.MAXIMUM;
    default:
      return MetricAggregationType.AVERAGE;
  }
}

/**
 * Use a StepScalingAction as an Alarm Action
 *
 * This class is here and not in aws-cloudwatch-actions because this library
 * needs to use the class, and otherwise we'd have a circular dependency:
 *
 * aws-autoscaling -> aws-cloudwatch-actions (for using the Action)
 * aws-cloudwatch-actions -> aws-autoscaling (for the definition of IStepScalingAction)
 */
class StepScalingAlarmAction implements cloudwatch.IAlarmAction {
  constructor(private readonly stepScalingAction: StepScalingAction) {
  }

  public bind(_scope: Construct, _alarm: cloudwatch.IAlarm): cloudwatch.AlarmActionConfig {
    return { alarmActionArn: this.stepScalingAction.scalingPolicyArn };
  }
}
