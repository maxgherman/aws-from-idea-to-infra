import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (event: any) => {
  const analysis = summarizeAnalysis(event.analysis);
  await db.send(new UpdateCommand({
    TableName: requiredEnv('ASSETS_TABLE_NAME'),
    Key: { assetId: event.assetId },
    UpdateExpression: 'SET #status = :status, outputKey = :outputKey, analysis = :analysis, updatedAt = :now REMOVE expiresAt, #error',
    ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
    ExpressionAttributeValues: {
      ':status': 'ready',
      ':outputKey': event.outputKey,
      ':analysis': analysis,
      ':now': new Date().toISOString(),
    },
    ConditionExpression: 'attribute_exists(assetId)',
  }));
  return event;
};

const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};

// Keep bounding boxes, taxonomy, and other unused service fields out of metadata.
export const summarizeAnalysis = (analysis: any) => {
  if (!Array.isArray(analysis?.labels) || typeof analysis?.modelVersion !== 'string') {
    throw new Error('Image analysis is missing');
  }
  return {
    service: 'rekognition',
    modelVersion: analysis.modelVersion,
    minConfidence: 80,
    labels: analysis.labels.slice(0, 10).map((label: any) => {
      if (typeof label.Name !== 'string' || !Number.isFinite(label.Confidence)
          || label.Confidence < 80 || label.Confidence > 100) {
        throw new Error('Invalid image analysis label');
      }
      return { name: label.Name, confidence: label.Confidence };
    }),
    analyzedAt: new Date().toISOString(),
  };
};
