import { config } from '@/config';
import { awsConsoleUrls } from './aws-console-urls';

/**
 * The AWS console link builders, bound to this deployment's region.
 *
 * The logic lives in `aws-console-urls.ts`, which takes the region as an
 * argument and imports nothing — so it can be tested as the plain string
 * manipulation it is, without a browser or a build step. This file is the one
 * place the two are joined, which is also why the region is read once here
 * rather than in fourteen builders.
 *
 * Pages import `aws` and call `aws.ecsService(...)`.
 */
export const aws = awsConsoleUrls(config.region);
