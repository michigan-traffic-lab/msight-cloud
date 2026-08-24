import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { ADMIN_ROLES, type AdminRole, type AdminUser } from '../../../shared/schemas/admin';
import { HttpError } from '../http';
import { resolveRole } from '../middleware/auth';

const client = new CognitoIdentityProviderClient({});

function userPoolId(): string {
  const value = process.env.USER_POOL_ID;
  if (!value) {
    throw new HttpError(
      500,
      'not_configured',
      'USER_POOL_ID is not set on the admin API function.'
    );
  }
  return value;
}

/**
 * Cognito's own validation failures are the caller's fault, not ours — surface
 * them as 4xx instead of letting them become an opaque 500.
 */
const CLIENT_ERRORS = new Set([
  'UsernameExistsException',
  'UserNotFoundException',
  'InvalidPasswordException',
  'InvalidParameterException',
  'GroupNotFoundException',
  'LimitExceededException',
  'NotAuthorizedException',
  'TooManyRequestsException',
]);

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && CLIENT_ERRORS.has(error.name)) {
      const status = error.name === 'UserNotFoundException' ? 404 : 400;
      throw new HttpError(status, error.name, error.message);
    }
    throw error;
  }
}

function attr(user: UserType, name: string): string | undefined {
  return user.Attributes?.find((entry) => entry.Name === name)?.Value;
}

export async function groupsForUser(username: string): Promise<string[]> {
  const result = await call(() =>
    client.send(
      new AdminListGroupsForUserCommand({ UserPoolId: userPoolId(), Username: username })
    )
  );
  return (result.Groups ?? [])
    .map((group) => group.GroupName)
    .filter((name): name is string => Boolean(name));
}

/**
 * Role membership is exclusive: a user holds exactly one role group, so stale
 * assignments never have to be arbitrated by precedence.
 */
export async function assignRole(username: string, role: AdminRole): Promise<void> {
  const current = await groupsForUser(username);

  for (const group of current) {
    if ((ADMIN_ROLES as readonly string[]).includes(group) && group !== role) {
      await call(() =>
        client.send(
          new AdminRemoveUserFromGroupCommand({
            UserPoolId: userPoolId(),
            Username: username,
            GroupName: group,
          })
        )
      );
    }
  }

  if (!current.includes(role)) {
    await call(() =>
      client.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: userPoolId(),
          Username: username,
          GroupName: role,
        })
      )
    );
  }
}

export async function listUsers(): Promise<AdminUser[]> {
  const collected: UserType[] = [];
  let paginationToken: string | undefined;

  do {
    const page = await call(() =>
      client.send(
        new ListUsersCommand({
          UserPoolId: userPoolId(),
          Limit: 60,
          PaginationToken: paginationToken,
        })
      )
    );
    collected.push(...(page.Users ?? []));
    paginationToken = page.PaginationToken;
  } while (paginationToken);

  // Cognito has no bulk "groups for many users" call, so this fans out one
  // request per user. Fine for a console with tens of operators; revisit if the
  // pool ever grows into the thousands.
  return Promise.all(
    collected.map(async (user) => {
      const username = user.Username ?? '';
      const groups = username ? await groupsForUser(username) : [];
      return {
        username,
        email: attr(user, 'email'),
        role: resolveRole(groups),
        enabled: user.Enabled ?? false,
        status: user.UserStatus ?? 'UNKNOWN',
        created_at: user.UserCreateDate?.toISOString() ?? null,
        last_modified_at: user.UserLastModifiedDate?.toISOString() ?? null,
      };
    })
  );
}

export async function createUser(input: {
  username: string;
  email: string;
  role: AdminRole;
  temporaryPassword?: string;
}): Promise<void> {
  await call(() =>
    client.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId(),
        Username: input.username,
        UserAttributes: [
          { Name: 'email', Value: input.email },
          { Name: 'email_verified', Value: 'true' },
        ],
        // Suppress the invitation email when we set the password ourselves;
        // otherwise Cognito mails a temporary one.
        MessageAction: input.temporaryPassword ? 'SUPPRESS' : undefined,
        TemporaryPassword: input.temporaryPassword,
      })
    )
  );

  if (input.temporaryPassword) {
    await setPassword(input.username, input.temporaryPassword, true);
  }

  await assignRole(input.username, input.role);
}

export async function deleteUser(username: string): Promise<void> {
  await call(() =>
    client.send(
      new AdminDeleteUserCommand({ UserPoolId: userPoolId(), Username: username })
    )
  );
}

export async function setEnabled(username: string, enabled: boolean): Promise<void> {
  await call(() =>
    client.send(
      enabled
        ? new AdminEnableUserCommand({ UserPoolId: userPoolId(), Username: username })
        : new AdminDisableUserCommand({ UserPoolId: userPoolId(), Username: username })
    )
  );
}

export async function setPassword(
  username: string,
  password: string,
  permanent: boolean
): Promise<void> {
  await call(() =>
    client.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId(),
        Username: username,
        Password: password,
        Permanent: permanent,
      })
    )
  );
}
