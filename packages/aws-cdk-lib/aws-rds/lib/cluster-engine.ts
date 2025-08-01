import { Construct } from 'constructs';
import * as semver from 'semver';
import { IEngine } from './engine';
import { EngineVersion } from './engine-version';
import { IParameterGroup, ParameterGroup } from './parameter-group';
import * as iam from '../../aws-iam';
import * as secretsmanager from '../../aws-secretsmanager';
import { ValidationError } from '../../core/lib/errors';

/**
 * The extra options passed to the `IClusterEngine.bindToCluster` method.
 */
export interface ClusterEngineBindOptions {
  /**
   * The role used for S3 importing.
   *
   * @default - none
   */
  readonly s3ImportRole?: iam.IRole;

  /**
   * The role used for S3 exporting.
   *
   *  @default - none
   */
  readonly s3ExportRole?: iam.IRole;

  /**
   * The customer-provided ParameterGroup.
   *
   * @default - none
   */
  readonly parameterGroup?: IParameterGroup;
}

/**
 * The type returned from the `IClusterEngine.bindToCluster` method.
 */
export interface ClusterEngineConfig {
  /**
   * The ParameterGroup to use for the cluster.
   *
   * @default - no ParameterGroup will be used
   */
  readonly parameterGroup?: IParameterGroup;

  /**
   * The port to use for this cluster,
   * unless the customer specified the port directly.
   *
   * @default - use the default port for clusters (3306)
   */
  readonly port?: number;

  /**
   * Features supported by the database engine.
   *
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DBEngineVersion.html
   *
   * @default - no features
   */
  readonly features?: ClusterEngineFeatures;
}

/**
 * Represents Database Engine features
 */
export interface ClusterEngineFeatures {
  /**
   * Feature name for the DB instance that the IAM role to access the S3 bucket for import
   * is to be associated with.
   *
   * @default - no s3Import feature name
   */
  readonly s3Import?: string;

  /**
   * Feature name for the DB instance that the IAM role to export to S3 bucket is to be
   * associated with.
   *
   * @default - no s3Export feature name
   */
  readonly s3Export?: string;

  /**
   * Whether the DB cluster engine supports the Aurora ServerlessV2 auto-pause feature.
   *
   * @default false
   */
  readonly serverlessV2AutoPauseSupported?: boolean;
}

/**
 * The interface representing a database cluster (as opposed to instance) engine.
 */
export interface IClusterEngine extends IEngine {
  /** The application used by this engine to perform rotation for a single-user scenario. */
  readonly singleUserRotationApplication: secretsmanager.SecretRotationApplication;

  /** The application used by this engine to perform rotation for a multi-user scenario. */
  readonly multiUserRotationApplication: secretsmanager.SecretRotationApplication;

  /** The log types that are available with this engine type */
  readonly supportedLogTypes: string[];

  /**
   * Whether the IAM Roles used for data importing and exporting need to be combined for this Engine,
   * or can they be kept separate.
   *
   * @default false
   */
  readonly combineImportAndExportRoles?: boolean;

  /**
   * Method called when the engine is used to create a new cluster.
   */
  bindToCluster(scope: Construct, options: ClusterEngineBindOptions): ClusterEngineConfig;
}

interface ClusterEngineBaseProps {
  readonly engineType: string;
  readonly singleUserRotationApplication: secretsmanager.SecretRotationApplication;
  readonly multiUserRotationApplication: secretsmanager.SecretRotationApplication;
  readonly defaultPort?: number;
  readonly engineVersion?: EngineVersion;
  readonly features?: ClusterEngineFeatures;
}

abstract class ClusterEngineBase implements IClusterEngine {
  public readonly engineType: string;
  public readonly engineVersion?: EngineVersion;
  public readonly parameterGroupFamily?: string;
  public readonly singleUserRotationApplication: secretsmanager.SecretRotationApplication;
  public readonly multiUserRotationApplication: secretsmanager.SecretRotationApplication;
  public abstract readonly supportedLogTypes: string[];

  private readonly defaultPort?: number;
  private readonly features?: ClusterEngineFeatures;

  constructor(props: ClusterEngineBaseProps) {
    this.engineType = props.engineType;
    this.features = props.features;
    this.singleUserRotationApplication = props.singleUserRotationApplication;
    this.multiUserRotationApplication = props.multiUserRotationApplication;
    this.defaultPort = props.defaultPort;
    this.engineVersion = props.engineVersion;
    this.parameterGroupFamily = this.engineVersion ? `${this.engineType}${this.engineVersion.majorVersion}` : undefined;
  }

  public bindToCluster(scope: Construct, options: ClusterEngineBindOptions): ClusterEngineConfig {
    const parameterGroup = options.parameterGroup ?? this.defaultParameterGroup(scope);
    return {
      parameterGroup,
      port: this.defaultPort,
      features: this.features,
    };
  }

  /**
   * Return an optional default ParameterGroup,
   * possibly an imported one,
   * if one wasn't provided by the customer explicitly.
   */
  protected abstract defaultParameterGroup(scope: Construct): IParameterGroup | undefined;
}

interface MysqlClusterEngineBaseProps {
  readonly engineType: string;
  readonly engineVersion?: EngineVersion;
  readonly defaultMajorVersion: string;
  readonly combineImportAndExportRoles?: boolean;
  readonly serverlessV2AutoPauseSupported?: boolean;
}

abstract class MySqlClusterEngineBase extends ClusterEngineBase {
  public readonly engineFamily = 'MYSQL';
  public readonly supportedLogTypes: string[] = ['error', 'general', 'slowquery', 'audit'];
  public readonly combineImportAndExportRoles?: boolean;

  constructor(props: MysqlClusterEngineBaseProps) {
    super({
      ...props,
      singleUserRotationApplication: secretsmanager.SecretRotationApplication.MYSQL_ROTATION_SINGLE_USER,
      multiUserRotationApplication: secretsmanager.SecretRotationApplication.MYSQL_ROTATION_MULTI_USER,
      engineVersion: props.engineVersion ? props.engineVersion : { majorVersion: props.defaultMajorVersion },
      features: {
        serverlessV2AutoPauseSupported: props.serverlessV2AutoPauseSupported,
      },
    });
    this.combineImportAndExportRoles = props.combineImportAndExportRoles;
  }

  public bindToCluster(scope: Construct, options: ClusterEngineBindOptions): ClusterEngineConfig {
    const config = super.bindToCluster(scope, options);
    const parameterGroup = options.parameterGroup ?? (options.s3ImportRole || options.s3ExportRole
      ? new ParameterGroup(scope, 'ClusterParameterGroup', {
        engine: this,
      })
      : config.parameterGroup);
    if (options.s3ImportRole) {
      // versions which combine the import and export Roles (right now, this is only 8.0)
      // require a different parameter name (identical for both import and export)
      const s3ImportParam = this.combineImportAndExportRoles
        ? 'aws_default_s3_role'
        : 'aurora_load_from_s3_role';
      parameterGroup?.addParameter(s3ImportParam, options.s3ImportRole.roleArn);
    }
    if (options.s3ExportRole) {
      const s3ExportParam = this.combineImportAndExportRoles
        ? 'aws_default_s3_role'
        : 'aurora_select_into_s3_role';
      parameterGroup?.addParameter(s3ExportParam, options.s3ExportRole.roleArn);
    }

    return {
      ...config,
      parameterGroup,
    };
  }
}

/**
 * The versions for the Aurora cluster engine
 * (those returned by `DatabaseClusterEngine.aurora`).
 *
 * @deprecated use `AuroraMysqlEngineVersion` instead
 */
export class AuroraEngineVersion {
  /** Version "5.6.10a". */
  public static readonly VER_10A = AuroraEngineVersion.builtIn_5_6('10a', false);
  /** Version "5.6.mysql_aurora.1.17.9". */
  public static readonly VER_1_17_9 = AuroraEngineVersion.builtIn_5_6('1.17.9');
  /** Version "5.6.mysql_aurora.1.19.0". */
  public static readonly VER_1_19_0 = AuroraEngineVersion.builtIn_5_6('1.19.0');
  /** Version "5.6.mysql_aurora.1.19.1". */
  public static readonly VER_1_19_1 = AuroraEngineVersion.builtIn_5_6('1.19.1');
  /** Version "5.6.mysql_aurora.1.19.2". */
  public static readonly VER_1_19_2 = AuroraEngineVersion.builtIn_5_6('1.19.2');
  /** Version "5.6.mysql_aurora.1.19.5". */
  public static readonly VER_1_19_5 = AuroraEngineVersion.builtIn_5_6('1.19.5');
  /** Version "5.6.mysql_aurora.1.19.6". */
  public static readonly VER_1_19_6 = AuroraEngineVersion.builtIn_5_6('1.19.6');
  /** Version "5.6.mysql_aurora.1.20.0". */
  public static readonly VER_1_20_0 = AuroraEngineVersion.builtIn_5_6('1.20.0');
  /** Version "5.6.mysql_aurora.1.20.1". */
  public static readonly VER_1_20_1 = AuroraEngineVersion.builtIn_5_6('1.20.1');
  /** Version "5.6.mysql_aurora.1.21.0". */
  public static readonly VER_1_21_0 = AuroraEngineVersion.builtIn_5_6('1.21.0');
  /** Version "5.6.mysql_aurora.1.22.0". */
  public static readonly VER_1_22_0 = AuroraEngineVersion.builtIn_5_6('1.22.0');
  /** Version "5.6.mysql_aurora.1.22.1". */
  public static readonly VER_1_22_1 = AuroraEngineVersion.builtIn_5_6('1.22.1');
  /** Version "5.6.mysql_aurora.1.22.1.3". */
  public static readonly VER_1_22_1_3 = AuroraEngineVersion.builtIn_5_6('1.22.1.3');
  /** Version "5.6.mysql_aurora.1.22.2". */
  public static readonly VER_1_22_2 = AuroraEngineVersion.builtIn_5_6('1.22.2');
  /** Version "5.6.mysql_aurora.1.22.3". */
  public static readonly VER_1_22_3 = AuroraEngineVersion.builtIn_5_6('1.22.3');
  /** Version "5.6.mysql_aurora.1.22.4". */
  public static readonly VER_1_22_4 = AuroraEngineVersion.builtIn_5_6('1.22.4');
  /** Version "5.6.mysql_aurora.1.22.5". */
  public static readonly VER_1_22_5 = AuroraEngineVersion.builtIn_5_6('1.22.5');
  /** Version "5.6.mysql_aurora.1.23.0". */
  public static readonly VER_1_23_0 = AuroraEngineVersion.builtIn_5_6('1.23.0');
  /** Version "5.6.mysql_aurora.1.23.1". */
  public static readonly VER_1_23_1 = AuroraEngineVersion.builtIn_5_6('1.23.1');
  /** Version "5.6.mysql_aurora.1.23.2". */
  public static readonly VER_1_23_2 = AuroraEngineVersion.builtIn_5_6('1.23.2');
  /** Version "5.6.mysql_aurora.1.23.3". */
  public static readonly VER_1_23_3 = AuroraEngineVersion.builtIn_5_6('1.23.3');
  /** Version "5.6.mysql_aurora.1.23.4". */
  public static readonly VER_1_23_4 = AuroraEngineVersion.builtIn_5_6('1.23.4');

  /**
   * Create a new AuroraEngineVersion with an arbitrary version.
   *
   * @param auroraFullVersion the full version string,
   *   for example "5.6.mysql_aurora.1.78.3.6"
   * @param auroraMajorVersion the major version of the engine,
   *   defaults to "5.6"
   */
  public static of(auroraFullVersion: string, auroraMajorVersion?: string): AuroraEngineVersion {
    return new AuroraEngineVersion(auroraFullVersion, auroraMajorVersion);
  }

  private static builtIn_5_6(minorVersion: string, addStandardPrefix: boolean = true): AuroraEngineVersion {
    return new AuroraEngineVersion(`5.6.${addStandardPrefix ? 'mysql_aurora.' : ''}${minorVersion}`);
  }

  /** The full version string, for example, "5.6.mysql_aurora.1.78.3.6". */
  public readonly auroraFullVersion: string;
  /** The major version of the engine. Currently, it's always "5.6". */
  public readonly auroraMajorVersion: string;

  private constructor(auroraFullVersion: string, auroraMajorVersion: string = '5.6') {
    this.auroraFullVersion = auroraFullVersion;
    this.auroraMajorVersion = auroraMajorVersion;
  }
}

/**
 * Creation properties of the plain Aurora database cluster engine.
 * Used in `DatabaseClusterEngine.aurora`.
 *
 * @deprecated use `AuroraMysqlClusterEngineProps` instead
 */
export interface AuroraClusterEngineProps {
  /** The version of the Aurora cluster engine. */
  readonly version: AuroraEngineVersion;
}

/**
 * @deprecated use `AuroraMysqlClusterEngine` instead
 */
class AuroraClusterEngine extends MySqlClusterEngineBase {
  constructor(version?: AuroraEngineVersion) {
    super({
      engineType: 'aurora',
      engineVersion: version
        ? {
          fullVersion: version.auroraFullVersion,
          majorVersion: version.auroraMajorVersion,
        }
        : undefined,
      defaultMajorVersion: '5.6',
    });
  }

  protected defaultParameterGroup(_scope: Construct): IParameterGroup | undefined {
    // the default.aurora5.6 ParameterGroup is actually the default,
    // so just return undefined in this case
    return undefined;
  }
}

/**
 * Options for the Aurora MySQL cluster engine version.
 */
interface AuroraMysqlEngineVersionOptions {
  /**
   * Whether this version requires combining the import and export IAM Roles.
   *
   * @default false
   */
  readonly combineImportAndExportRoles?: boolean;

  /**
   * Whether this version supports the Aurora SeverlessV2 auto-pause feature.
   *
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html#auto-pause-prereqs
   * @default false
   */
  readonly serverlessV2AutoPauseSupported?: boolean;
}

/**
 * The versions for the Aurora MySQL cluster engine
 * (those returned by `DatabaseClusterEngine.auroraMysql`).
 *
 * https://docs.aws.amazon.com/AmazonRDS/latest/AuroraMySQLReleaseNotes/Welcome.html
 */
export class AuroraMysqlEngineVersion {
  /**
   * Version "5.7.12".
   * @deprecated Version 5.7.12 is no longer supported by Amazon RDS.
   */
  public static readonly VER_5_7_12 = AuroraMysqlEngineVersion.builtIn_5_7('12', false);
  /**
   * Version "5.7.mysql_aurora.2.02.3"
   * @deprecated Version 5.7.mysql_aurora.2.02.3 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_02_3 = AuroraMysqlEngineVersion.builtIn_5_7('2.02.3');
  /**
   * Version "5.7.mysql_aurora.2.03.2".
   * @deprecated Version 5.7.mysql_aurora.2.03.2 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_03_2 = AuroraMysqlEngineVersion.builtIn_5_7('2.03.2');
  /**
   * Version "5.7.mysql_aurora.2.03.3".
   * @deprecated Version 5.7.mysql_aurora.2.03.3 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_03_3 = AuroraMysqlEngineVersion.builtIn_5_7('2.03.3');
  /**
   * Version "5.7.mysql_aurora.2.03.4".
   * @deprecated Version 5.7.mysql_aurora.2.03.4 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_03_4 = AuroraMysqlEngineVersion.builtIn_5_7('2.03.4');
  /**
   * Version "5.7.mysql_aurora.2.04.0".
   * @deprecated Version 5.7.mysql_aurora.2.04.0 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_04_0 = AuroraMysqlEngineVersion.builtIn_5_7('2.04.0');
  /**
   * Version "5.7.mysql_aurora.2.04.1".
   * @deprecated Version 5.7.mysql_aurora.2.04.1 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_04_1 = AuroraMysqlEngineVersion.builtIn_5_7('2.04.1');
  /**
   * Version "5.7.mysql_aurora.2.04.2".
   * @deprecated Version 5.7.mysql_aurora.2.04.2 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_04_2 = AuroraMysqlEngineVersion.builtIn_5_7('2.04.2');
  /**
   * Version "5.7.mysql_aurora.2.04.3".
   * @deprecated Version 5.7.mysql_aurora.2.04.3 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_04_3 = AuroraMysqlEngineVersion.builtIn_5_7('2.04.3');
  /**
   * Version "5.7.mysql_aurora.2.04.4".
   * @deprecated Version 5.7.mysql_aurora.2.04.4 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_04_4 = AuroraMysqlEngineVersion.builtIn_5_7('2.04.4');
  /**
   * Version "5.7.mysql_aurora.2.04.5".
   * @deprecated Version 5.7.mysql_aurora.2.04.5 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_04_5 = AuroraMysqlEngineVersion.builtIn_5_7('2.04.5');
  /**
   * Version "5.7.mysql_aurora.2.04.6".
   * @deprecated Version 5.7.mysql_aurora.2.04.6 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_04_6 = AuroraMysqlEngineVersion.builtIn_5_7('2.04.6');
  /**
   * Version "5.7.mysql_aurora.2.04.7".
   * @deprecated Version 5.7.mysql_aurora.2.04.7 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_04_7 = AuroraMysqlEngineVersion.builtIn_5_7('2.04.7');
  /**
   * Version "5.7.mysql_aurora.2.04.8".
   * @deprecated Version 5.7.mysql_aurora.2.04.8 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_04_8 = AuroraMysqlEngineVersion.builtIn_5_7('2.04.8');
  /**
   * Version "5.7.mysql_aurora.2.04.9"
   * @deprecated Version 5.7.mysql_aurora.2.04.9 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_04_9 = AuroraMysqlEngineVersion.builtIn_5_7('2.04.9');
  /**
   * Version "5.7.mysql_aurora.2.05.0".
   * @deprecated Version 5.7.mysql_aurora.2.05.0 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_05_0 = AuroraMysqlEngineVersion.builtIn_5_7('2.05.0');
  /**
   * Version "5.7.mysql_aurora.2.05.1"
   * @deprecated Version 5.7.mysql_aurora.2.05.1 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_05_1 = AuroraMysqlEngineVersion.builtIn_5_7('2.05.1');
  /**
   * Version "5.7.mysql_aurora.2.06.0".
   * @deprecated Version 5.7.mysql_aurora.2.06.0 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_06_0 = AuroraMysqlEngineVersion.builtIn_5_7('2.06.0');
  /**
   * Version "5.7.mysql_aurora.2.07.0".
   * @deprecated Version 5.7.mysql_aurora.2.07.0 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_07_0 = AuroraMysqlEngineVersion.builtIn_5_7('2.07.0');
  /**
   * Version "5.7.mysql_aurora.2.07.1".
   * @deprecated Version 5.7.mysql_aurora.2.07.1 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_07_1 = AuroraMysqlEngineVersion.builtIn_5_7('2.07.1');
  /**
   * Version "5.7.mysql_aurora.2.07.2".
   * @deprecated Version 5.7.mysql_aurora.2.07.2 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_07_2 = AuroraMysqlEngineVersion.builtIn_5_7('2.07.2');
  /**
   * Version "5.7.mysql_aurora.2.07.3".
   * @deprecated Version 5.7.mysql_aurora.2.07.3 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_07_3 = AuroraMysqlEngineVersion.builtIn_5_7('2.07.3');
  /**
   * Version "5.7.mysql_aurora.2.07.4"
   * @deprecated Version 5.7.mysql_aurora.2.07.4 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_07_4 = AuroraMysqlEngineVersion.builtIn_5_7('2.07.4');
  /**
   * Version "5.7.mysql_aurora.2.07.5".
   * @deprecated Version 5.7.mysql_aurora.2.07.5 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_07_5 = AuroraMysqlEngineVersion.builtIn_5_7('2.07.5');
  /**
   * Version "5.7.mysql_aurora.2.07.6".
   * @deprecated Version 5.7.mysql_aurora.2.07.6 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_07_6 = AuroraMysqlEngineVersion.builtIn_5_7('2.07.6');
  /**
   * Version "5.7.mysql_aurora.2.07.7".
   * @deprecated Version 5.7.mysql_aurora.2.07.7 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_07_7 = AuroraMysqlEngineVersion.builtIn_5_7('2.07.7');
  /**
   * Version "5.7.mysql_aurora.2.07.8".
   * @deprecated Version 5.7.mysql_aurora.2.07.8 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_07_8 = AuroraMysqlEngineVersion.builtIn_5_7('2.07.8');
  /**
   * Version "5.7.mysql_aurora.2.07.9".
   * @deprecated Version 5.7.mysql_aurora.2.07.9 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_07_9 = AuroraMysqlEngineVersion.builtIn_5_7('2.07.9');
  /**
   * Version "5.7.mysql_aurora.2.07.10".
   * @deprecated Version 5.7.mysql_aurora.2.07.10 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_07_10 = AuroraMysqlEngineVersion.builtIn_5_7('2.07.10');
  /**
   * Version "5.7.mysql_aurora.2.08.0".
   * @deprecated Version 5.7.mysql_aurora.2.08.0 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_08_0 = AuroraMysqlEngineVersion.builtIn_5_7('2.08.0');
  /**
   * Version "5.7.mysql_aurora.2.08.1".
   * @deprecated Version 5.7.mysql_aurora.2.08.1 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_08_1 = AuroraMysqlEngineVersion.builtIn_5_7('2.08.1');
  /**
   * Version "5.7.mysql_aurora.2.08.2".
   * @deprecated Version 5.7.mysql_aurora.2.08.2 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_08_2 = AuroraMysqlEngineVersion.builtIn_5_7('2.08.2');
  /**
   * Version "5.7.mysql_aurora.2.08.3".
   * @deprecated Version 5.7.mysql_aurora.2.08.3 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_08_3 = AuroraMysqlEngineVersion.builtIn_5_7('2.08.3');
  /**
   * Version "5.7.mysql_aurora.2.08.4".
   * @deprecated Version 5.7.mysql_aurora.2.08.4 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_08_4 = AuroraMysqlEngineVersion.builtIn_5_7('2.08.4');
  /**
   * Version "5.7.mysql_aurora.2.09.0".
   * @deprecated Version 5.7.mysql_aurora.2.09.0 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_09_0 = AuroraMysqlEngineVersion.builtIn_5_7('2.09.0');
  /**
   * Version "5.7.mysql_aurora.2.09.1".
   * @deprecated Version 5.7.mysql_aurora.2.09.1 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_09_1 = AuroraMysqlEngineVersion.builtIn_5_7('2.09.1');
  /**
   * Version "5.7.mysql_aurora.2.09.2".
   * @deprecated Version 5.7.mysql_aurora.2.09.2 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_09_2 = AuroraMysqlEngineVersion.builtIn_5_7('2.09.2');
  /**
   * Version "5.7.mysql_aurora.2.09.3".
   * @deprecated Version 5.7.mysql_aurora.2.09.3 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_09_3 = AuroraMysqlEngineVersion.builtIn_5_7('2.09.3');
  /**
   * Version "5.7.mysql_aurora.2.10.0".
   * @deprecated Version 5.7.mysql_aurora.2.10.0 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_10_0 = AuroraMysqlEngineVersion.builtIn_5_7('2.10.0');
  /**
   * Version "5.7.mysql_aurora.2.10.1".
   * @deprecated Version 5.7.mysql_aurora.2.10.1 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_10_1 = AuroraMysqlEngineVersion.builtIn_5_7('2.10.1');
  /**
   * Version "5.7.mysql_aurora.2.10.2".
   * @deprecated Version 5.7.mysql_aurora.2.10.2 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_10_2 = AuroraMysqlEngineVersion.builtIn_5_7('2.10.2');
  /**
   * Version "5.7.mysql_aurora.2.10.3".
   * @deprecated Version 5.7.mysql_aurora.2.10.3 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_10_3 = AuroraMysqlEngineVersion.builtIn_5_7('2.10.3');
  /**
   * Version "5.7.mysql_aurora.2.11.0"
   * @deprecated Version 5.7.mysql_aurora.2.11.0 is no longer supported by Amazon RDS.
   */
  public static readonly VER_2_11_0 = AuroraMysqlEngineVersion.builtIn_5_7('2.11.0');
  /** Version "5.7.mysql_aurora.2.11.1". */
  public static readonly VER_2_11_1 = AuroraMysqlEngineVersion.builtIn_5_7('2.11.1');
  /** Version "5.7.mysql_aurora.2.11.2". */
  public static readonly VER_2_11_2 = AuroraMysqlEngineVersion.builtIn_5_7('2.11.2');
  /** Version "5.7.mysql_aurora.2.11.3". */
  public static readonly VER_2_11_3 = AuroraMysqlEngineVersion.builtIn_5_7('2.11.3');
  /** Version "5.7.mysql_aurora.2.11.4". */
  public static readonly VER_2_11_4 = AuroraMysqlEngineVersion.builtIn_5_7('2.11.4');
  /** Version "5.7.mysql_aurora.2.11.5". */
  public static readonly VER_2_11_5 = AuroraMysqlEngineVersion.builtIn_5_7('2.11.5');
  /** Version "5.7.mysql_aurora.2.11.6". */
  public static readonly VER_2_11_6 = AuroraMysqlEngineVersion.builtIn_5_7('2.11.6');
  /** Version "5.7.mysql_aurora.2.12.0". */
  public static readonly VER_2_12_0 = AuroraMysqlEngineVersion.builtIn_5_7('2.12.0');
  /** Version "5.7.mysql_aurora.2.12.1". */
  public static readonly VER_2_12_1 = AuroraMysqlEngineVersion.builtIn_5_7('2.12.1');
  /** Version "5.7.mysql_aurora.2.12.2". */
  public static readonly VER_2_12_2 = AuroraMysqlEngineVersion.builtIn_5_7('2.12.2');
  /** Version "5.7.mysql_aurora.2.12.3". */
  public static readonly VER_2_12_3 = AuroraMysqlEngineVersion.builtIn_5_7('2.12.3');
  /** Version "5.7.mysql_aurora.2.12.4". */
  public static readonly VER_2_12_4 = AuroraMysqlEngineVersion.builtIn_5_7('2.12.4');
  /** Version "5.7.mysql_aurora.2.12.5". */
  public static readonly VER_2_12_5 = AuroraMysqlEngineVersion.builtIn_5_7('2.12.5');
  /**
   * Version "8.0.mysql_aurora.3.01.0"
   * @deprecated Aurora MySQL 8.0.mysql_aurora.3.01.0 is no longer supported by Amazon RDS.
   */
  public static readonly VER_3_01_0 = AuroraMysqlEngineVersion.builtIn_8_0('3.01.0');
  /**
   * Version "8.0.mysql_aurora.3.01.1"
   * @deprecated Aurora MySQL 8.0.mysql_aurora.3.01.1 is no longer supported by Amazon RDS.
   */
  public static readonly VER_3_01_1 = AuroraMysqlEngineVersion.builtIn_8_0('3.01.1');
  /**
   * Version "8.0.mysql_aurora.3.02.0"
   * @deprecated Aurora MySQL 8.0.mysql_aurora.3.02.0 is no longer supported by Amazon RDS.
   */
  public static readonly VER_3_02_0 = AuroraMysqlEngineVersion.builtIn_8_0('3.02.0');
  /**
   * Version "8.0.mysql_aurora.3.02.1"
   * @deprecated Aurora MySQL 8.0.mysql_aurora.3.02.1 is no longer supported by Amazon RDS.
   */
  public static readonly VER_3_02_1 = AuroraMysqlEngineVersion.builtIn_8_0('3.02.1');
  /**
   * Version "8.0.mysql_aurora.3.02.2"
   * @deprecated Aurora MySQL 8.0.mysql_aurora.3.02.2 is no longer supported by Amazon RDS.
   */
  public static readonly VER_3_02_2 = AuroraMysqlEngineVersion.builtIn_8_0('3.02.2');
  /**
   * Version "8.0.mysql_aurora.3.02.3"
   * @deprecated Aurora MySQL 8.0.mysql_aurora.3.02.3 is no longer supported by Amazon RDS.
   */
  public static readonly VER_3_02_3 = AuroraMysqlEngineVersion.builtIn_8_0('3.02.3');
  /**
   * Version "8.0.mysql_aurora.3.03.0"
   * @deprecated Aurora MySQL 8.0.mysql_aurora.3.03.0 is no longer supported by Amazon RDS.
   */
  public static readonly VER_3_03_0 = AuroraMysqlEngineVersion.builtIn_8_0('3.03.0');
  /**
   * Version "8.0.mysql_aurora.3.03.1"
   * @deprecated Aurora MySQL 8.0.mysql_aurora.3.03.1 is no longer supported by Amazon RDS.
   */
  public static readonly VER_3_03_1 = AuroraMysqlEngineVersion.builtIn_8_0('3.03.1');
  /**
   * Version "8.0.mysql_aurora.3.03.2"
   * @deprecated Aurora MySQL 8.0.mysql_aurora.3.03.2 is no longer supported by Amazon RDS.
   */
  public static readonly VER_3_03_2 = AuroraMysqlEngineVersion.builtIn_8_0('3.03.2');
  /**
   * Version "8.0.mysql_aurora.3.03.3"
   * @deprecated Aurora MySQL 8.0.mysql_aurora.3.03.3 is no longer supported by Amazon RDS.
   */
  public static readonly VER_3_03_3 = AuroraMysqlEngineVersion.builtIn_8_0('3.03.3');
  /** Version "8.0.mysql_aurora.3.04.0". */
  public static readonly VER_3_04_0 = AuroraMysqlEngineVersion.builtIn_8_0('3.04.0');
  /** Version "8.0.mysql_aurora.3.04.1". */
  public static readonly VER_3_04_1 = AuroraMysqlEngineVersion.builtIn_8_0('3.04.1');
  /** Version "8.0.mysql_aurora.3.04.2". */
  public static readonly VER_3_04_2 = AuroraMysqlEngineVersion.builtIn_8_0('3.04.2');
  /** Version "8.0.mysql_aurora.3.04.3". */
  public static readonly VER_3_04_3 = AuroraMysqlEngineVersion.builtIn_8_0('3.04.3');
  /** Version "8.0.mysql_aurora.3.04.4". */
  public static readonly VER_3_04_4 = AuroraMysqlEngineVersion.builtIn_8_0('3.04.4');
  /**
   * Version "8.0.mysql_aurora.3.05.0"
   * @deprecated Aurora MySQL 8.0.mysql_aurora.3.05.0 is no longer supported by Amazon RDS.
   */
  public static readonly VER_3_05_0 = AuroraMysqlEngineVersion.builtIn_8_0('3.05.0');
  /**
   * Version "8.0.mysql_aurora.3.05.1"
   * @deprecated Aurora MySQL 8.0.mysql_aurora.3.05.1 is no longer supported by Amazon RDS.
   */
  public static readonly VER_3_05_1 = AuroraMysqlEngineVersion.builtIn_8_0('3.05.1');
  /** Version "8.0.mysql_aurora.3.05.2". */
  public static readonly VER_3_05_2 = AuroraMysqlEngineVersion.builtIn_8_0('3.05.2');
  /** Version "8.0.mysql_aurora.3.06.0". */
  public static readonly VER_3_06_0 = AuroraMysqlEngineVersion.builtIn_8_0('3.06.0');
  /** Version "8.0.mysql_aurora.3.06.1". */
  public static readonly VER_3_06_1 = AuroraMysqlEngineVersion.builtIn_8_0('3.06.1');
  /** Version "8.0.mysql_aurora.3.07.0". */
  public static readonly VER_3_07_0 = AuroraMysqlEngineVersion.builtIn_8_0('3.07.0');
  /** Version "8.0.mysql_aurora.3.07.1". */
  public static readonly VER_3_07_1 = AuroraMysqlEngineVersion.builtIn_8_0('3.07.1');
  /** Version "8.0.mysql_aurora.3.08.0". */
  public static readonly VER_3_08_0 = AuroraMysqlEngineVersion.builtIn_8_0('3.08.0');
  /** Version "8.0.mysql_aurora.3.08.1". */
  public static readonly VER_3_08_1 = AuroraMysqlEngineVersion.builtIn_8_0('3.08.1');
  /** Version "8.0.mysql_aurora.3.08.2". */
  public static readonly VER_3_08_2 = AuroraMysqlEngineVersion.builtIn_8_0('3.08.2');
  /** Version "8.0.mysql_aurora.3.09.0". */
  public static readonly VER_3_09_0 = AuroraMysqlEngineVersion.builtIn_8_0('3.09.0');
  /** Version "8.0.mysql_aurora.3.10.0". */
  public static readonly VER_3_10_0 = AuroraMysqlEngineVersion.builtIn_8_0('3.10.0');

  /**
   * Create a new AuroraMysqlEngineVersion with an arbitrary version.
   *
   * @param auroraMysqlFullVersion the full version string,
   *   for example "5.7.mysql_aurora.2.78.3.6"
   * @param auroraMysqlMajorVersion the major version of the engine,
   *   defaults to "5.7"
   */
  public static of(auroraMysqlFullVersion: string, auroraMysqlMajorVersion?: string): AuroraMysqlEngineVersion {
    // Detects whether the auto-pause feature is supported.
    // https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html#auto-pause-prereqs
    const coercedVersion = semver.valid(semver.coerce(auroraMysqlMajorVersion));
    const serverlessV2AutoPauseSupported = auroraMysqlMajorVersion === '8.0'
      ? auroraMysqlFullVersion >= '8.0.mysql_aurora.3.08.0'
      : (coercedVersion != null && semver.satisfies(coercedVersion, '>=8.1'));
    return new AuroraMysqlEngineVersion(
      auroraMysqlFullVersion, auroraMysqlMajorVersion,
      {
        combineImportAndExportRoles: (auroraMysqlMajorVersion ? auroraMysqlMajorVersion !== '5.7' : false),
        serverlessV2AutoPauseSupported,
      },
    );
  }

  private static builtIn_5_7(minorVersion: string, addStandardPrefix: boolean = true): AuroraMysqlEngineVersion {
    return new AuroraMysqlEngineVersion(`5.7.${addStandardPrefix ? 'mysql_aurora.' : ''}${minorVersion}`);
  }

  private static builtIn_8_0(minorVersion: string): AuroraMysqlEngineVersion {
    // 8.0 of the MySQL engine needs to combine the import and export Roles
    return new AuroraMysqlEngineVersion(`8.0.mysql_aurora.${minorVersion}`, '8.0', {
      combineImportAndExportRoles: true,
      serverlessV2AutoPauseSupported: minorVersion >= '3.08.0',
    });
  }

  /** The full version string, for example, "5.7.mysql_aurora.1.78.3.6". */
  public readonly auroraMysqlFullVersion: string;
  /** The major version of the engine. Currently, it's either "5.7", or "8.0". */
  public readonly auroraMysqlMajorVersion: string;
  /**
   * Whether this version requires combining the import and export IAM Roles.
   *
   * @internal
   */
  public readonly _combineImportAndExportRoles?: boolean;
  /**
   * Whether this version supports the Aurora ServerlessV2 auto-pause feature.
   *
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html
   * @internal
   */
  public readonly _serverlessV2AutoPauseSupported?: boolean;

  private constructor(
    auroraMysqlFullVersion: string,
    auroraMysqlMajorVersion: string = '5.7',
    auroraMysqlEngineVersionOptions?: AuroraMysqlEngineVersionOptions,
  ) {
    this.auroraMysqlFullVersion = auroraMysqlFullVersion;
    this.auroraMysqlMajorVersion = auroraMysqlMajorVersion;
    this._combineImportAndExportRoles = auroraMysqlEngineVersionOptions?.combineImportAndExportRoles;
    this._serverlessV2AutoPauseSupported = auroraMysqlEngineVersionOptions?.serverlessV2AutoPauseSupported;
  }
}

/**
 * Creation properties of the Aurora MySQL database cluster engine.
 * Used in `DatabaseClusterEngine.auroraMysql`.
 */
export interface AuroraMysqlClusterEngineProps {
  /** The version of the Aurora MySQL cluster engine. */
  readonly version: AuroraMysqlEngineVersion;
}

class AuroraMysqlClusterEngine extends MySqlClusterEngineBase {
  constructor(version?: AuroraMysqlEngineVersion) {
    super({
      engineType: 'aurora-mysql',
      engineVersion: version
        ? {
          fullVersion: version.auroraMysqlFullVersion,
          majorVersion: version.auroraMysqlMajorVersion,
        }
        : undefined,
      defaultMajorVersion: '5.7',
      combineImportAndExportRoles: version?._combineImportAndExportRoles,
      serverlessV2AutoPauseSupported: version?._serverlessV2AutoPauseSupported,
    });
  }

  protected defaultParameterGroup(scope: Construct): IParameterGroup | undefined {
    return ParameterGroup.fromParameterGroupName(scope, 'AuroraMySqlDatabaseClusterEngineDefaultParameterGroup',
      `default.${this.parameterGroupFamily}`);
  }
}

/**
 * Features supported by this version of the Aurora Postgres cluster engine.
 */
export interface AuroraPostgresEngineFeatures {
  /**
   * Whether this version of the Aurora Postgres cluster engine supports the S3 data import feature.
   *
   * @default false
   */
  readonly s3Import?: boolean;

  /**
   * Whether this version of the Aurora Postgres cluster engine supports the S3 data export feature.
   *
   * @default false
   */
  readonly s3Export?: boolean;

  /**
   * Whether this version of the Aurora Postgres cluster engine supports the Aurora SeverlessV2 auto-pause feature.
   *
   * @see https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html#auto-pause-prereqs
   * @default false
   */
  readonly serverlessV2AutoPauseSupported?: boolean;
}

/**
 * The versions for the Aurora PostgreSQL cluster engine
 * (those returned by `DatabaseClusterEngine.auroraPostgres`).
 *
 * https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Updates.html
 */
export class AuroraPostgresEngineVersion {
  /**
   * Version "9.6.8".
   * @deprecated Version 9.6.8 is no longer supported by Amazon RDS.
   */
  public static readonly VER_9_6_8 = AuroraPostgresEngineVersion.of('9.6.8', '9.6');
  /**
   * Version "9.6.9".
   * @deprecated Version 9.6.9 is no longer supported by Amazon RDS.
   */
  public static readonly VER_9_6_9 = AuroraPostgresEngineVersion.of('9.6.9', '9.6');
  /**
   * Version "9.6.11".
   * @deprecated Version 9.6.11 is no longer supported by Amazon RDS.
   */
  public static readonly VER_9_6_11 = AuroraPostgresEngineVersion.of('9.6.11', '9.6');
  /**
   * Version "9.6.12".
   * @deprecated Version 9.6.12 is no longer supported by Amazon RDS.
   */
  public static readonly VER_9_6_12 = AuroraPostgresEngineVersion.of('9.6.12', '9.6');
  /**
   * Version "9.6.16".
   * @deprecated Version 9.6.16 is no longer supported by Amazon RDS.
   */
  public static readonly VER_9_6_16 = AuroraPostgresEngineVersion.of('9.6.16', '9.6');
  /**
   * Version "9.6.17".
   * @deprecated Version 9.6.17 is no longer supported by Amazon RDS.
   */
  public static readonly VER_9_6_17 = AuroraPostgresEngineVersion.of('9.6.17', '9.6');
  /**
   * Version "9.6.18".
   * @deprecated Version 9.6.18 is no longer supported by Amazon RDS.
   */
  public static readonly VER_9_6_18 = AuroraPostgresEngineVersion.of('9.6.18', '9.6');
  /**
   * Version "9.6.19".
   * @deprecated Version 9.6.19 is no longer supported by Amazon RDS.
   */
  public static readonly VER_9_6_19 = AuroraPostgresEngineVersion.of('9.6.19', '9.6');
  /**
   * Version "9.6.22"
   * @deprecated Version 9.6.22 is no longer supported by Amazon RDS.
   */
  public static readonly VER_9_6_22 = AuroraPostgresEngineVersion.of('9.6.22', '9.6');
  /**
   *  Version "10.4".
   * @deprecated Version 10.4 is no longer supported by Amazon RDS.
   */
  public static readonly VER_10_4 = AuroraPostgresEngineVersion.of('10.4', '10');
  /**
   *  Version "10.5".
   * @deprecated Version 10.5 is no longer supported by Amazon RDS.
   */
  public static readonly VER_10_5 = AuroraPostgresEngineVersion.of('10.5', '10');
  /**
   *  Version "10.6".
   * @deprecated Version 10.6 is no longer supported by Amazon RDS.
   */
  public static readonly VER_10_6 = AuroraPostgresEngineVersion.of('10.6', '10');
  /**
   *  Version "10.7".
   * @deprecated Version 10.7 is no longer supported by Amazon RDS.
   */
  public static readonly VER_10_7 = AuroraPostgresEngineVersion.of('10.7', '10', { s3Import: true });
  /**
   *  Version "10.11".
   * @deprecated Version 10.11 is no longer supported by Amazon RDS.
   */
  public static readonly VER_10_11 = AuroraPostgresEngineVersion.of('10.11', '10', { s3Import: true, s3Export: true });
  /**
   *  Version "10.12".
   * @deprecated Version 10.12 is no longer supported by Amazon RDS.
   */
  public static readonly VER_10_12 = AuroraPostgresEngineVersion.of('10.12', '10', { s3Import: true, s3Export: true });
  /**
   *  Version "10.13".
   * @deprecated Version 10.13 is no longer supported by Amazon RDS.
   */
  public static readonly VER_10_13 = AuroraPostgresEngineVersion.of('10.13', '10', { s3Import: true, s3Export: true });
  /**
   *  Version "10.14".
   * @deprecated Version 10.14 is no longer supported by Amazon RDS.
   */
  public static readonly VER_10_14 = AuroraPostgresEngineVersion.of('10.14', '10', { s3Import: true, s3Export: true });
  /**
   *  Version "10.16".
   * @deprecated Version 10.16 is no longer supported by Amazon RDS.
   */
  public static readonly VER_10_16 = AuroraPostgresEngineVersion.of('10.16', '10', { s3Import: true, s3Export: true });
  /**
   *  Version "10.17".
   * @deprecated Version 10.17 is no longer supported by Amazon RDS.
   */
  public static readonly VER_10_17 = AuroraPostgresEngineVersion.of('10.17', '10', { s3Import: true, s3Export: true });
  /**
   *  Version "10.18".
   * @deprecated Version 10.18 is no longer supported by Amazon RDS.
   */
  public static readonly VER_10_18 = AuroraPostgresEngineVersion.of('10.18', '10', { s3Import: true, s3Export: true });
  /**
   *  Version "10.19".
   * @deprecated Version 10.19 is no longer supported by Amazon RDS.
   */
  public static readonly VER_10_19 = AuroraPostgresEngineVersion.of('10.19', '10', { s3Import: true, s3Export: true });
  /**
   *  Version "10.20".
   * @deprecated Version 10.20 is no longer supported by Amazon RDS.
   */
  public static readonly VER_10_20 = AuroraPostgresEngineVersion.of('10.20', '10', { s3Import: true, s3Export: true });
  /**
   *  Version "10.21".
   * @deprecated Version 10.21 is no longer supported by Amazon RDS.
   */
  public static readonly VER_10_21 = AuroraPostgresEngineVersion.of('10.21', '10', { s3Import: true, s3Export: true });
  /**
   *  Version "11.4".
   * @deprecated Version 11.4 is no longer supported by Amazon RDS.
   */
  public static readonly VER_11_4 = AuroraPostgresEngineVersion.of('11.4', '11', { s3Import: true });
  /**
   *  Version "11.6".
   * @deprecated Version 11.6 is no longer supported by Amazon RDS.
   */
  public static readonly VER_11_6 = AuroraPostgresEngineVersion.of('11.6', '11', { s3Import: true, s3Export: true });
  /**
   *  Version "11.7".
   * @deprecated Version 11.7 is no longer supported by Amazon RDS.
   */
  public static readonly VER_11_7 = AuroraPostgresEngineVersion.of('11.7', '11', { s3Import: true, s3Export: true });
  /**
   *  Version "11.8".
   * @deprecated Version 11.8 is no longer supported by Amazon RDS.
   */
  public static readonly VER_11_8 = AuroraPostgresEngineVersion.of('11.8', '11', { s3Import: true, s3Export: true });
  /** Version "11.9". */
  public static readonly VER_11_9 = AuroraPostgresEngineVersion.of('11.9', '11', { s3Import: true, s3Export: true });
  /**
   *  Version "11.11".
   * @deprecated Version 11.11 is no longer supported by Amazon RDS.
   */
  public static readonly VER_11_11 = AuroraPostgresEngineVersion.of('11.11', '11', { s3Import: true, s3Export: true });
  /**
   *  Version "11.12".
   * @deprecated Version 11.12 is no longer supported by Amazon RDS.
   */
  public static readonly VER_11_12 = AuroraPostgresEngineVersion.of('11.12', '11', { s3Import: true, s3Export: true });
  /**
   *  Version "11.13".
   * @deprecated Version 11.13 is no longer supported by Amazon RDS.
   */
  public static readonly VER_11_13 = AuroraPostgresEngineVersion.of('11.13', '11', { s3Import: true, s3Export: true });
  /**
   *  Version "11.14".
   * @deprecated Version 11.14 is no longer supported by Amazon RDS.
   */
  public static readonly VER_11_14 = AuroraPostgresEngineVersion.of('11.14', '11', { s3Import: true, s3Export: true });
  /**
   *  Version "11.15".
   * @deprecated Version 11.15 is no longer supported by Amazon RDS.
   */
  public static readonly VER_11_15 = AuroraPostgresEngineVersion.of('11.15', '11', { s3Import: true, s3Export: true });
  /**
   * Version "11.16"
   * @deprecated Version 11.16 is no longer supported by Amazon RDS.
   */
  public static readonly VER_11_16 = AuroraPostgresEngineVersion.of('11.16', '11', { s3Import: true, s3Export: true });
  /**
   * Version "11.17"
   * @deprecated Version 11.17 is no longer supported by Amazon RDS.
   */
  public static readonly VER_11_17 = AuroraPostgresEngineVersion.of('11.17', '11', { s3Import: true, s3Export: true });
  /**
   * Version "11.18"
   * @deprecated Version 11.18 is no longer supported by Amazon RDS.
   */
  public static readonly VER_11_18 = AuroraPostgresEngineVersion.of('11.18', '11', { s3Import: true, s3Export: true });
  /**
   * Version "11.19"
   * @deprecated Version 11.19 is no longer supported by Amazon RDS.
   */
  public static readonly VER_11_19 = AuroraPostgresEngineVersion.of('11.19', '11', { s3Import: true, s3Export: true });
  /**
   * Version "11.20"
   * @deprecated Version 11.20 is no longer supported by Amazon RDS.
   */
  public static readonly VER_11_20 = AuroraPostgresEngineVersion.of('11.20', '11', { s3Import: true, s3Export: true });
  /** Version "11.21". */
  public static readonly VER_11_21 = AuroraPostgresEngineVersion.of('11.21', '11', { s3Import: true, s3Export: true });
  /**
   *  Version "12.4".
   * @deprecated Version 12.4 is no longer supported by Amazon RDS.
   */
  public static readonly VER_12_4 = AuroraPostgresEngineVersion.of('12.4', '12', { s3Import: true, s3Export: true });
  /**
   *  Version "12.6".
   * @deprecated Version 12.6 is no longer supported by Amazon RDS.
   */
  public static readonly VER_12_6 = AuroraPostgresEngineVersion.of('12.6', '12', { s3Import: true, s3Export: true });
  /**
   *  Version "12.7".
   * @deprecated Version 12.7 is no longer supported by Amazon RDS.
   */
  public static readonly VER_12_7 = AuroraPostgresEngineVersion.of('12.7', '12', { s3Import: true, s3Export: true });
  /**
   *  Version "12.8".
   * @deprecated Version 12.8 is no longer supported by Amazon RDS.
   */
  public static readonly VER_12_8 = AuroraPostgresEngineVersion.of('12.8', '12', { s3Import: true, s3Export: true });
  /** Version "12.9". */
  public static readonly VER_12_9 = AuroraPostgresEngineVersion.of('12.9', '12', { s3Import: true, s3Export: true });
  /**
   *  Version "12.10".
   * @deprecated Version 12.10 is no longer supported by Amazon RDS.
   */
  public static readonly VER_12_10 = AuroraPostgresEngineVersion.of('12.10', '12', { s3Import: true, s3Export: true });
  /**
   * Version "12.11".
   * @deprecated Version 12.11 is no longer supported by Amazon RDS.
   */
  public static readonly VER_12_11 = AuroraPostgresEngineVersion.of('12.11', '12', { s3Import: true, s3Export: true });
  /**
   * Version "12.12".
   * @deprecated Version 12.12 is no longer supported by Amazon RDS.
   */
  public static readonly VER_12_12 = AuroraPostgresEngineVersion.of('12.12', '12', { s3Import: true, s3Export: true });
  /**
   * Version "12.13".
   * @deprecated Version 12.13 is no longer supported by Amazon RDS.
   */
  public static readonly VER_12_13 = AuroraPostgresEngineVersion.of('12.13', '12', { s3Import: true, s3Export: true });
  /**
   * Version "12.14".
   * @deprecated Version 12.14 is no longer supported by Amazon RDS.
   */
  public static readonly VER_12_14 = AuroraPostgresEngineVersion.of('12.14', '12', { s3Import: true, s3Export: true });
  /**
   * Version "12.15".
   * @deprecated Version 12.15 is no longer supported by Amazon RDS.
   */
  public static readonly VER_12_15 = AuroraPostgresEngineVersion.of('12.15', '12', { s3Import: true, s3Export: true });
  /**
   * Version "12.16".
   * @deprecated Version 12.16 is no longer supported by Amazon RDS.
   */
  public static readonly VER_12_16 = AuroraPostgresEngineVersion.of('12.16', '12', { s3Import: true, s3Export: true });
  /**
   * Version "12.17".
   * @deprecated Version 12.17 is no longer supported by Amazon RDS.
   */
  public static readonly VER_12_17 = AuroraPostgresEngineVersion.of('12.17', '12', { s3Import: true, s3Export: true });
  /**
   * Version "12.18".
   * @deprecated Version 12.18 is no longer supported by Amazon RDS.
   */
  public static readonly VER_12_18 = AuroraPostgresEngineVersion.of('12.18', '12', { s3Import: true, s3Export: true });
  /**
   * Version "12.19".
   * @deprecated Version 12.19 is no longer supported by Amazon RDS.
   */
  public static readonly VER_12_19 = AuroraPostgresEngineVersion.of('12.19', '12', { s3Import: true, s3Export: true });
  /**
   * Version "12.20".
   * @deprecated Version 12.20 is no longer supported by Amazon RDS.
   */
  public static readonly VER_12_20 = AuroraPostgresEngineVersion.of('12.20', '12', { s3Import: true, s3Export: true });
  /**
   * Version "12.21".
   * @deprecated Version 12.21 is no longer supported by Amazon RDS.
   */
  public static readonly VER_12_21 = AuroraPostgresEngineVersion.of('12.21', '12', { s3Import: true, s3Export: true });
  /** Version "12.22". */
  public static readonly VER_12_22 = AuroraPostgresEngineVersion.of('12.22', '12', { s3Import: true, s3Export: true });
  /**
   *  Version "13.3".
   * @deprecated Version 13.3 is no longer supported by Amazon RDS.
   */
  public static readonly VER_13_3 = AuroraPostgresEngineVersion.of('13.3', '13', { s3Import: true, s3Export: true });
  /**
   *  Version "13.4".
   * @deprecated Version 13.4 is no longer supported by Amazon RDS.
   */
  public static readonly VER_13_4 = AuroraPostgresEngineVersion.of('13.4', '13', { s3Import: true, s3Export: true });
  /**
   *  Version "13.5".
   * @deprecated Version 13.5 is no longer supported by Amazon RDS.
   */
  public static readonly VER_13_5 = AuroraPostgresEngineVersion.of('13.5', '13', { s3Import: true, s3Export: true });
  /**
   *  Version "13.6".
   * @deprecated Version 13.6 is no longer supported by Amazon RDS.
   */
  public static readonly VER_13_6 = AuroraPostgresEngineVersion.of('13.6', '13', { s3Import: true, s3Export: true });
  /**
   * Version "13.7".
   * @deprecated Version 13.7 is no longer supported by Amazon RDS.
   */
  public static readonly VER_13_7 = AuroraPostgresEngineVersion.of('13.7', '13', { s3Import: true, s3Export: true });
  /**
   * Version "13.8".
   * @deprecated Version 13.8 is no longer supported by Amazon RDS.
   */
  public static readonly VER_13_8 = AuroraPostgresEngineVersion.of('13.8', '13', { s3Import: true, s3Export: true });
  /** Version "13.9". */
  public static readonly VER_13_9 = AuroraPostgresEngineVersion.of('13.9', '13', { s3Import: true, s3Export: true });
  /**
   * Version "13.10".
   * @deprecated Version 13.10 is no longer supported by Amazon RDS.
   */
  public static readonly VER_13_10 = AuroraPostgresEngineVersion.of('13.10', '13', { s3Import: true, s3Export: true });
  /** Version "13.11". */
  public static readonly VER_13_11 = AuroraPostgresEngineVersion.of('13.11', '13', { s3Import: true, s3Export: true });
  /** Version "13.12". */
  public static readonly VER_13_12 = AuroraPostgresEngineVersion.of('13.12', '13', { s3Import: true, s3Export: true });
  /** Version "13.13". */
  public static readonly VER_13_13 = AuroraPostgresEngineVersion.of('13.13', '13', { s3Import: true, s3Export: true });
  /** Version "13.14". */
  public static readonly VER_13_14 = AuroraPostgresEngineVersion.of('13.14', '13', { s3Import: true, s3Export: true });
  /** Version "13.15". */
  public static readonly VER_13_15 = AuroraPostgresEngineVersion.of('13.15', '13', { s3Import: true, s3Export: true });
  /** Version "13.16". */
  public static readonly VER_13_16 = AuroraPostgresEngineVersion.of('13.16', '13', { s3Import: true, s3Export: true });
  /**
   * Version "13.17".
   * @deprecated Version 13.17 is no longer supported by Amazon RDS.
   */
  public static readonly VER_13_17 = AuroraPostgresEngineVersion.of('13.17', '13', { s3Import: true, s3Export: true });
  /** Version "13.18". */
  public static readonly VER_13_18 = AuroraPostgresEngineVersion.of('13.18', '13', { s3Import: true, s3Export: true });
  /** Version "13.20". */
  public static readonly VER_13_20 = AuroraPostgresEngineVersion.of('13.20', '13', { s3Import: true, s3Export: true });
  /**
   * Version "14.3".
   * @deprecated Version 14.3 is no longer supported by Amazon RDS.
   */
  public static readonly VER_14_3 = AuroraPostgresEngineVersion.of('14.3', '14', { s3Import: true, s3Export: true });
  /**
   * Version "14.4".
   * @deprecated Version 14.4 is no longer supported by Amazon RDS.
   */
  public static readonly VER_14_4 = AuroraPostgresEngineVersion.of('14.4', '14', { s3Import: true, s3Export: true });
  /**
   * Version "14.5".
   * @deprecated Version 14.5 is no longer supported by Amazon RDS.
   */
  public static readonly VER_14_5 = AuroraPostgresEngineVersion.of('14.5', '14', { s3Import: true, s3Export: true });
  /** Version "14.6". */
  public static readonly VER_14_6 = AuroraPostgresEngineVersion.of('14.6', '14', { s3Import: true, s3Export: true });
  /**
   * Version "14.7".
   * @deprecated Version 14.7 is no longer supported by Amazon RDS.
   */
  public static readonly VER_14_7 = AuroraPostgresEngineVersion.of('14.7', '14', { s3Import: true, s3Export: true });
  /** Version "14.8". */
  public static readonly VER_14_8 = AuroraPostgresEngineVersion.of('14.8', '14', { s3Import: true, s3Export: true });
  /** Version "14.9". */
  public static readonly VER_14_9 = AuroraPostgresEngineVersion.of('14.9', '14', { s3Import: true, s3Export: true });
  /** Version "14.10". */
  public static readonly VER_14_10 = AuroraPostgresEngineVersion.of('14.10', '14', { s3Import: true, s3Export: true });
  /** Version "14.11". */
  public static readonly VER_14_11 = AuroraPostgresEngineVersion.of('14.11', '14', { s3Import: true, s3Export: true });
  /** Version "14.12". */
  public static readonly VER_14_12 = AuroraPostgresEngineVersion.of('14.12', '14', { s3Import: true, s3Export: true });
  /** Version "14.13". */
  public static readonly VER_14_13 = AuroraPostgresEngineVersion.of('14.13', '14', { s3Import: true, s3Export: true });
  /**
   * Version "14.14".
   * @deprecated Version 14.14 is no longer supported by Amazon RDS.
   */
  public static readonly VER_14_14 = AuroraPostgresEngineVersion.of('14.14', '14', { s3Import: true, s3Export: true });
  /** Version "14.15". */
  public static readonly VER_14_15 = AuroraPostgresEngineVersion.of('14.15', '14', { s3Import: true, s3Export: true });
  /** Version "14.17". */
  public static readonly VER_14_17 = AuroraPostgresEngineVersion.of('14.17', '14', { s3Import: true, s3Export: true });
  /**
   * Version "15.2".
   * @deprecated Version 15.2 is no longer supported by Amazon RDS.
   */
  public static readonly VER_15_2 = AuroraPostgresEngineVersion.of('15.2', '15', { s3Import: true, s3Export: true });
  /** Version "15.3". */
  public static readonly VER_15_3 = AuroraPostgresEngineVersion.of('15.3', '15', { s3Import: true, s3Export: true });
  /** Version "15.4". */
  public static readonly VER_15_4 = AuroraPostgresEngineVersion.of('15.4', '15', { s3Import: true, s3Export: true });
  /** Version "15.5". */
  public static readonly VER_15_5 = AuroraPostgresEngineVersion.of('15.5', '15', { s3Import: true, s3Export: true });
  /** Version "15.6". */
  public static readonly VER_15_6 = AuroraPostgresEngineVersion.of('15.6', '15', { s3Import: true, s3Export: true });
  /** Version "15.7". */
  public static readonly VER_15_7 = AuroraPostgresEngineVersion.of('15.7', '15', { s3Import: true, s3Export: true });
  /** Version "15.8". */
  public static readonly VER_15_8 = AuroraPostgresEngineVersion.of('15.8', '15', { s3Import: true, s3Export: true });
  /**
   * Version "15.9".
   * @deprecated Version 15.9 is no longer supported by Amazon RDS.
   */
  public static readonly VER_15_9 = AuroraPostgresEngineVersion.of('15.9', '15', { s3Import: true, s3Export: true });
  /** Version "15.10". */
  public static readonly VER_15_10 = AuroraPostgresEngineVersion.of('15.10', '15', { s3Import: true, s3Export: true });
  /** Version "15.12". */
  public static readonly VER_15_12 = AuroraPostgresEngineVersion.of('15.12', '15', { s3Import: true, s3Export: true });
  /**
   * Version "16.0"
   * @deprecated Version 16.0 is no longer supported by Amazon RDS.
   */
  public static readonly VER_16_0 = AuroraPostgresEngineVersion.of('16.0', '16', { s3Import: true, s3Export: true });
  /** Version "16.1". */
  public static readonly VER_16_1 = AuroraPostgresEngineVersion.of('16.1', '16', { s3Import: true, s3Export: true });
  /** Version "16.2". */
  public static readonly VER_16_2 = AuroraPostgresEngineVersion.of('16.2', '16', { s3Import: true, s3Export: true });
  /** Version "16.3". */
  public static readonly VER_16_3 = AuroraPostgresEngineVersion.of('16.3', '16', { s3Import: true, s3Export: true });
  /** Version "16.4". */
  public static readonly VER_16_4 = AuroraPostgresEngineVersion.of('16.4', '16', { s3Import: true, s3Export: true });
  /** Version "16.4 limitless" */
  public static readonly VER_16_4_LIMITLESS = AuroraPostgresEngineVersion.of('16.4-limitless', '16', { s3Import: true, s3Export: true });
  /**
   * Version "16.5"
   * @deprecated Version 16.5 is no longer supported by Amazon RDS.
   */
  public static readonly VER_16_5 = AuroraPostgresEngineVersion.of('16.5', '16', { s3Import: true, s3Export: true });
  /** Version "16.6". */
  public static readonly VER_16_6 = AuroraPostgresEngineVersion.of('16.6', '16', { s3Import: true, s3Export: true });
  /** Version "16.6 limitless" */
  public static readonly VER_16_6_LIMITLESS = AuroraPostgresEngineVersion.of('16.6-limitless', '16', { s3Import: true, s3Export: true });
  /** Version "16.8". */
  public static readonly VER_16_8 = AuroraPostgresEngineVersion.of('16.8', '16', { s3Import: true, s3Export: true });
  /** Version "16.8 limitless" */
  public static readonly VER_16_8_LIMITLESS = AuroraPostgresEngineVersion.of('16.8-limitless', '16', { s3Import: true, s3Export: true });
  /**
   * Version "17.1"
   * @deprecated Version 17.1 is no longer supported by Amazon RDS.
   */
  public static readonly VER_17_1 = AuroraPostgresEngineVersion.of('17.1', '17', { s3Import: true, s3Export: true });
  /**
   * Version "17.2"
   * @deprecated Version 17.2 is no longer supported by Amazon RDS.
   */
  public static readonly VER_17_2 = AuroraPostgresEngineVersion.of('17.2', '17', { s3Import: true, s3Export: true });
  /** Version "17.4". */
  public static readonly VER_17_4 = AuroraPostgresEngineVersion.of('17.4', '17', { s3Import: true, s3Export: true });
  /** Version "17.5". */
  public static readonly VER_17_5 = AuroraPostgresEngineVersion.of('17.5', '17', { s3Import: true, s3Export: true });

  /**
   * Create a new AuroraPostgresEngineVersion with an arbitrary version.
   *
   * @param auroraPostgresFullVersion the full version string,
   *   for example "9.6.25.1"
   * @param auroraPostgresMajorVersion the major version of the engine,
   *   for example "9.6"
   */
  public static of(auroraPostgresFullVersion: string, auroraPostgresMajorVersion: string,
    auroraPostgresFeatures?: AuroraPostgresEngineFeatures): AuroraPostgresEngineVersion {
    // Detects whether the auto-pause feature is supported.
    // https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html#auto-pause-prereqs
    const coercedVersion = semver.valid(semver.coerce(auroraPostgresFullVersion));
    const serverlessV2AutoPauseSupported = coercedVersion != null && semver.satisfies(coercedVersion, '>=16.3 || ^15.7 || ^14.12 || ^13.15');
    return new AuroraPostgresEngineVersion(auroraPostgresFullVersion, auroraPostgresMajorVersion, {
      serverlessV2AutoPauseSupported,
      ...auroraPostgresFeatures,
    });
  }

  /** The full version string, for example, "9.6.25.1". */
  public readonly auroraPostgresFullVersion: string;
  /** The major version of the engine, for example, "9.6". */
  public readonly auroraPostgresMajorVersion: string;
  /**
   * The supported features for the DB engine
   *
   * @internal
   */
  public readonly _features: ClusterEngineFeatures;

  private constructor(auroraPostgresFullVersion: string, auroraPostgresMajorVersion: string, auroraPostgresFeatures?: AuroraPostgresEngineFeatures) {
    this.auroraPostgresFullVersion = auroraPostgresFullVersion;
    this.auroraPostgresMajorVersion = auroraPostgresMajorVersion;
    this._features = {
      s3Import: auroraPostgresFeatures?.s3Import ? 's3Import' : undefined,
      s3Export: auroraPostgresFeatures?.s3Export ? 's3Export' : undefined,
      serverlessV2AutoPauseSupported: auroraPostgresFeatures?.serverlessV2AutoPauseSupported,
    };
  }
}

/**
 * Creation properties of the Aurora PostgreSQL database cluster engine.
 * Used in `DatabaseClusterEngine.auroraPostgres`.
 */
export interface AuroraPostgresClusterEngineProps {
  /** The version of the Aurora PostgreSQL cluster engine. */
  readonly version: AuroraPostgresEngineVersion;
}

class AuroraPostgresClusterEngine extends ClusterEngineBase {
  /**
   * feature name for the S3 data import feature
   */
  private static readonly S3_IMPORT_FEATURE_NAME = 's3Import';

  /**
   * feature name for the S3 data export feature
   */
  private static readonly S3_EXPORT_FEATURE_NAME = 's3Export';

  public readonly engineFamily = 'POSTGRESQL';
  public readonly defaultUsername = 'postgres';
  public readonly supportedLogTypes: string[] = ['postgresql'];

  constructor(version?: AuroraPostgresEngineVersion) {
    super({
      engineType: 'aurora-postgresql',
      singleUserRotationApplication: secretsmanager.SecretRotationApplication.POSTGRES_ROTATION_SINGLE_USER,
      multiUserRotationApplication: secretsmanager.SecretRotationApplication.POSTGRES_ROTATION_MULTI_USER,
      defaultPort: 5432,
      engineVersion: version
        ? {
          fullVersion: version.auroraPostgresFullVersion,
          majorVersion: version.auroraPostgresMajorVersion,
        }
        : undefined,
      features: version
        ? {
          s3Import: version._features.s3Import ? AuroraPostgresClusterEngine.S3_IMPORT_FEATURE_NAME : undefined,
          s3Export: version._features.s3Export ? AuroraPostgresClusterEngine.S3_EXPORT_FEATURE_NAME : undefined,
          serverlessV2AutoPauseSupported: version._features.serverlessV2AutoPauseSupported,
        }
        : {
          s3Import: AuroraPostgresClusterEngine.S3_IMPORT_FEATURE_NAME,
          s3Export: AuroraPostgresClusterEngine.S3_EXPORT_FEATURE_NAME,
        },
    });
  }

  public bindToCluster(scope: Construct, options: ClusterEngineBindOptions): ClusterEngineConfig {
    const config = super.bindToCluster(scope, options);
    // skip validation for unversioned as it might be supported/unsupported. we cannot reliably tell at compile-time
    if (this.engineVersion?.fullVersion) {
      if (options.s3ImportRole && !(config.features?.s3Import)) {
        throw new ValidationError(`s3Import is not supported for Postgres version: ${this.engineVersion.fullVersion}. Use a version that supports the s3Import feature.`, scope);
      }
      if (options.s3ExportRole && !(config.features?.s3Export)) {
        throw new ValidationError(`s3Export is not supported for Postgres version: ${this.engineVersion.fullVersion}. Use a version that supports the s3Export feature.`, scope);
      }
    }
    return config;
  }

  protected defaultParameterGroup(scope: Construct): IParameterGroup | undefined {
    if (!this.parameterGroupFamily) {
      throw new ValidationError('Could not create a new ParameterGroup for an unversioned aurora-postgresql cluster engine. ' +
        'Please either use a versioned engine, or pass an explicit ParameterGroup when creating the cluster', scope);
    }
    return ParameterGroup.fromParameterGroupName(scope, 'AuroraPostgreSqlDatabaseClusterEngineDefaultParameterGroup',
      `default.${this.parameterGroupFamily}`);
  }
}

/**
 * A database cluster engine. Provides mapping to the serverless application
 * used for secret rotation.
 */
export class DatabaseClusterEngine {
  /**
   * The unversioned 'aurora' cluster engine.
   *
   * **Note**: we do not recommend using unversioned engines for non-serverless Clusters,
   *   as that can pose an availability risk.
   *   We recommend using versioned engines created using the `aurora()` method
   *
   * @deprecated use `AURORA_MYSQL` instead
   */
  public static readonly AURORA: IClusterEngine = new AuroraClusterEngine();

  /**
   * The unversioned 'aurora-msql' cluster engine.
   *
   * **Note**: we do not recommend using unversioned engines for non-serverless Clusters,
   *   as that can pose an availability risk.
   *   We recommend using versioned engines created using the `auroraMysql()` method
   */
  public static readonly AURORA_MYSQL: IClusterEngine = new AuroraMysqlClusterEngine();

  /**
   * The unversioned 'aurora-postgresql' cluster engine.
   *
   * **Note**: we do not recommend using unversioned engines for non-serverless Clusters,
   *   as that can pose an availability risk.
   *   We recommend using versioned engines created using the `auroraPostgres()` method
   */
  public static readonly AURORA_POSTGRESQL: IClusterEngine = new AuroraPostgresClusterEngine();

  /**
   * Creates a new plain Aurora database cluster engine.
   *
   * @deprecated use `auroraMysql()` instead
   */
  public static aurora(props: AuroraClusterEngineProps): IClusterEngine {
    return new AuroraClusterEngine(props.version);
  }

  /** Creates a new Aurora MySQL database cluster engine. */
  public static auroraMysql(props: AuroraMysqlClusterEngineProps): IClusterEngine {
    return new AuroraMysqlClusterEngine(props.version);
  }

  /** Creates a new Aurora PostgreSQL database cluster engine. */
  public static auroraPostgres(props: AuroraPostgresClusterEngineProps): IClusterEngine {
    return new AuroraPostgresClusterEngine(props.version);
  }
}
