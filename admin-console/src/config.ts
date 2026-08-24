function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in from the cdk deploy outputs.`
    );
  }
  return value;
}

export const config = {
  region: required('VITE_AWS_REGION', import.meta.env.VITE_AWS_REGION),
  userPoolId: required('VITE_USER_POOL_ID', import.meta.env.VITE_USER_POOL_ID),
  userPoolClientId: required(
    'VITE_USER_POOL_CLIENT_ID',
    import.meta.env.VITE_USER_POOL_CLIENT_ID
  ),
  adminApiUrl: required('VITE_ADMIN_API_URL', import.meta.env.VITE_ADMIN_API_URL).replace(
    /\/+$/,
    ''
  ),
};
