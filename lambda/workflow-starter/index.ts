import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

const stepFunctions = new SFNClient({});

type AssetWorkflowInput = {
  assetId: string;
  sourceKey: string;
};

export const handler = async (event: any) => {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const message of event.Records ?? []) {
    try {
      const assets = parseAssetRecords(message.body);
      for (const asset of assets) await startWorkflow(asset);
    } catch (error) {
      console.error('Could not start asset workflow', { messageId: message.messageId, error });
      batchItemFailures.push({ itemIdentifier: message.messageId });
    }
  }

  return { batchItemFailures };
};

export const parseAssetRecords = (body: string): AssetWorkflowInput[] => {
  const event = JSON.parse(body);
  const records = event.Records ?? [];
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('S3 notification contains no records');
  }

  return records.map((record: any) => {
    const sourceKey = decodeURIComponent(record?.s3?.object?.key?.replace(/\+/g, ' ') ?? '');
    const match = sourceKey.match(/^uploads\/originals\/([0-9a-f-]+)\.(png|jpg)$/);
    if (!match) throw new Error(`Unexpected object key: ${sourceKey}`);
    return { assetId: match[1], sourceKey };
  });
};

const startWorkflow = async (asset: AssetWorkflowInput) => {
  try {
    await stepFunctions.send(new StartExecutionCommand({
      stateMachineArn: requiredEnv('STATE_MACHINE_ARN'),
      name: asset.assetId,
      input: JSON.stringify(asset),
    }));
  } catch (error: any) {
    if (error?.name === 'ExecutionAlreadyExists') {
      console.info('Asset workflow already exists', { assetId: asset.assetId });
      return;
    }
    throw error;
  }
};

const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};
