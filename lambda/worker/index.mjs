export const handler = async (event) => {
  const failures = [];

  for (const record of event.Records ?? []) {
    let payload;

    try {
      payload = JSON.parse(record.body);
    } catch (error) {
      console.error('Failed to parse SQS message body', {
        messageId: record.messageId,
        body: record.body,
        error,
      });
      failures.push({ itemIdentifier: record.messageId });
      continue;
    }

    if (payload.fail) {
      console.error('Worker rejected message on purpose to demonstrate the DLQ path', {
        messageId: record.messageId,
        payload,
      });
      failures.push({ itemIdentifier: record.messageId });
      continue;
    }

    console.log('Processed async job', {
      messageId: record.messageId,
      payload,
      processedAt: new Date().toISOString(),
    });
  }

  return {
    batchItemFailures: failures,
  };
};
