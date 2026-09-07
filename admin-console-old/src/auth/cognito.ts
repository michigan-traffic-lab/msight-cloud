import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { config } from '@/config';

const userPool = new CognitoUserPool({
  UserPoolId: config.userPoolId,
  ClientId: config.userPoolClientId,
});

/**
 * Raised when Cognito hands back a NEW_PASSWORD_REQUIRED challenge — the state
 * a user is in after an admin creates them without an explicit password. The
 * caller collects a new password and calls `completeNewPassword`.
 */
export class NewPasswordRequiredError extends Error {
  constructor(readonly user: CognitoUser) {
    super('A new password is required before you can sign in.');
    this.name = 'NewPasswordRequiredError';
  }
}

export function signIn(username: string, password: string): Promise<CognitoUserSession> {
  const user = new CognitoUser({ Username: username, Pool: userPool });
  const details = new AuthenticationDetails({ Username: username, Password: password });

  return new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: (session) => resolve(session),
      onFailure: (error) => reject(error),
      newPasswordRequired: () => reject(new NewPasswordRequiredError(user)),
    });
  });
}

export function completeNewPassword(
  user: CognitoUser,
  newPassword: string
): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(
      newPassword,
      {},
      {
        onSuccess: (session) => resolve(session),
        onFailure: (error) => reject(error),
      }
    );
  });
}

/**
 * Returns the current session, refreshing it if the ID token has expired.
 * Resolves to null when nobody is signed in.
 */
export function currentSession(): Promise<CognitoUserSession | null> {
  const user = userPool.getCurrentUser();
  if (!user) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    user.getSession((error: Error | null, session: CognitoUserSession | null) => {
      if (error || !session || !session.isValid()) {
        resolve(null);
        return;
      }
      resolve(session);
    });
  });
}

/**
 * The ID token, not the access token: the API Gateway authorizer validates
 * against the app client audience, and only the ID token carries the email
 * claim the console displays.
 */
export async function idToken(): Promise<string | null> {
  const session = await currentSession();
  return session ? session.getIdToken().getJwtToken() : null;
}

export function signOut(): void {
  userPool.getCurrentUser()?.signOut();
}
