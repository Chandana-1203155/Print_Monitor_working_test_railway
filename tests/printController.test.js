jest.mock('../backend/models', () => ({
  PrintLog: {
    findOrCreate: jest.fn(),
    create: jest.fn()
  },
  User: {}
}));

const { PrintLog } = require('../backend/models');
const { logPrint } = require('../backend/controllers/printController');

const createResponse = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('logPrint idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('stores client id and print timestamp and returns the existing record on retry', async () => {
    const printedAt = '2026-10-08T01:00:00.000Z';
    const existingLog = { id: 7, user_id: 42, client_job_id: 'bde2533e-0c71-41b0-a3b3-111111111111' };
    PrintLog.findOrCreate.mockResolvedValue([existingLog, false]);
    const req = {
      user: { id: 42 },
      body: {
        file_name: 'report.pdf',
        num_pages: 10,
        copies: 2,
        page_range: '1-3',
        printer_name: 'Office Printer',
        status: 'success',
        client_job_id: 'bde2533e-0c71-41b0-a3b3-111111111111',
        printed_at: printedAt
      }
    };
    const res = createResponse();

    await logPrint(req, res);

    const [query] = PrintLog.findOrCreate.mock.calls[0];
    expect(query.where).toEqual({ client_job_id: req.body.client_job_id });
    expect(query.defaults).toEqual(expect.objectContaining({
      user_id: 42,
      num_pages: 3,
      copies: 2,
      total_sheets: 6,
      client_job_id: req.body.client_job_id,
      created_at: new Date(printedAt)
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      message: 'Print job was already logged.',
      log: existingLog
    }));
  });

  test('rejects a duplicate job id belonging to another user', async () => {
    PrintLog.findOrCreate.mockResolvedValue([
      { id: 7, user_id: 99 },
      false
    ]);
    const req = {
      user: { id: 42 },
      body: {
        file_name: 'report.pdf',
        client_job_id: 'bde2533e-0c71-41b0-a3b3-111111111111'
      }
    };
    const res = createResponse();

    await logPrint(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(PrintLog.create).not.toHaveBeenCalled();
  });
});
