import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({});
const headers = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
};

export const handler = async (event) => {
  const queueUrl = process.env.QUEUE_URL;
  const prNumber = process.env.PR_NUMBER ?? 'local';

  if (!queueUrl) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: 'QUEUE_URL is not configured' }),
    };
  }

  let payload;
  try {
    payload = event?.body ? JSON.parse(event.body) : {};
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        ok: false,
        error: 'Invalid JSON body',
      }),
    };
  }

  const task = typeof payload?.task === 'string' && payload.task.trim()
    ? payload.task.trim()
    : 'demo-job';

  const shouldFail = payload?.fail === true;
  const body = {
    task,
    fail: shouldFail,
    prNumber,
    requestedAt: new Date().toISOString(),
  };

  const response = await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
    }),
  );

  return {
    statusCode: 202,
    headers,
    body: JSON.stringify({
      ok: true,
      queued: true,
      messageId: response.MessageId,
      task,
      fail: shouldFail,
      note: shouldFail
        ? 'This message will be retried and then moved to the DLQ.'
        : 'The worker Lambda will process this message asynchronously.',
    }),
  };
};
