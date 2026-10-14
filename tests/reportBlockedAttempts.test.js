jest.mock('../backend/models', () => ({ PrintLog: {}, User: {} }));
jest.mock('../backend/utils/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

const { logAudit } = require('../backend/utils/audit');
const { reportBlockedAttempts } = require('../backend/controllers/printController');

const createResponse = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
const makeReq = (attempts) => ({ user: { id: 5, username: 'prof', role: 'faculty' }, body: { attempts } });

describe('reportBlockedAttempts', () => {
  beforeEach(() => jest.clearAllMocks());

  test('stores each attempt in the audit log', async () => {
    const res = createResponse();
    await reportBlockedAttempts(makeReq([
      { document: 'secret.docx', printer: 'HP', windows_user: 'lab', machine: 'PC1', occurred_at: '2026-10-14T01:00:00.000Z' },
      { document: 'b.pdf', printer: 'HP' }
    ]), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ success: true, recorded: 2 });
    expect(logAudit).toHaveBeenCalledTimes(2);
    expect(logAudit.mock.calls[0][0]).toEqual(expect.objectContaining({
      userId: 5, action: 'print_blocked',
      metadata: expect.objectContaining({ document: 'secret.docx', windows_user: 'lab', machine: 'PC1', occurred_at: '2026-10-14T01:00:00.000Z' })
    }));
  });

  test('rejects an empty or oversized batch', async () => {
    for (const attempts of [undefined, [], 'nope', new Array(51).fill({ document: 'x' })]) {
      const res = createResponse();
      await reportBlockedAttempts(makeReq(attempts), res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('cleans and limits text, and fixes impossible timestamps', async () => {
    const res = createResponse();
    await reportBlockedAttempts(makeReq([
      { document: `a\u0000b${'z'.repeat(500)}`, occurred_at: '2999-01-01T00:00:00Z' }
    ]), res);
    const { metadata } = logAudit.mock.calls[0][0];
    expect(metadata.document).not.toMatch(/[\u0000-\u001f]/);
    expect(metadata.document.length).toBeLessThanOrEqual(255);
    expect(new Date(metadata.occurred_at).getTime()).toBeLessThan(Date.now() + 86400000);
  });
});
