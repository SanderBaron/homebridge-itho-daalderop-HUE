import { DEFAULT_FAN_NAME } from '@/settings';
import { IthoDaalderopAccessoryContext } from '@/types';
import hap from '@homebridge/hap-nodejs';

export const mockDisplayName = DEFAULT_FAN_NAME;
export const mockUUID = hap.uuid.generate(mockDisplayName);

export const mockAccessoryContext = {} satisfies IthoDaalderopAccessoryContext;
