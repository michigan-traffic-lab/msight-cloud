import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient({});

interface BootstrapProperties {
  UserPoolId: string;
  Username: string;
  Email: string;
  Password: string;
  Role: string;
}

interface CustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: BootstrapProperties & { ServiceToken: string };
}

/**
 * Seeds the master console account from deploy.config.yaml.
 *
 * Runs on every Create and Update, and is written to be idempotent: an existing
 * account has its email and password brought back in line with the config
 * rather than failing the deployment.
 *
 * Delete is deliberately a no-op. Tearing down the stack removes the user pool
 * and every account with it; deleting the master account on any other resource
 * replacement would be a way to lock yourself out for no benefit.
 */
export async function handler(event: CustomResourceEvent) {
  const { RequestType, ResourceProperties } = event;
  const { UserPoolId, Username, Email, Password, Role } = ResourceProperties;

  const physicalResourceId = `msight-admin-bootstrap-${UserPoolId}-${Username}`;

  if (RequestType === 'Delete') {
    return { PhysicalResourceId: physicalResourceId };
  }

  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId,
        Username,
        UserAttributes: [
          { Name: 'email', Value: Email },
          { Name: 'email_verified', Value: 'true' },
        ],
        // We set a permanent password below, so suppress the invitation email.
        MessageAction: 'SUPPRESS',
      })
    );
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'UsernameExistsException') {
      throw error;
    }

    // Already present from an earlier deploy — reconcile the email instead.
    await cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId,
        Username,
        UserAttributes: [
          { Name: 'email', Value: Email },
          { Name: 'email_verified', Value: 'true' },
        ],
      })
    );
  }

  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId,
      Username,
      Password,
      Permanent: true,
    })
  );

  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId,
      Username,
      GroupName: Role,
    })
  );

  return {
    PhysicalResourceId: physicalResourceId,
    Data: { Username, Email, Role },
  };
}
