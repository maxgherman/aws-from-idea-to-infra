export const handler = async () => {
  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    },
    body: JSON.stringify({
      ok: true,
      message: 'hello from lambda',
      time: new Date().toISOString(),
    }),
  };
};
