jest.mock('../backend/models', () => ({
  User: {
    findOne: jest.fn()
  }
}));

jest.mock('../backend/utils/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../backend/services/emailService', () => ({}));

const { User } = require('../backend/models');
const { login } = require('../backend/controllers/authController');

const createResponse = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('admin login lockout policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('does not block an admin account with an existing lockout timestamp', async () => {
    const admin = {
      id: 1,
      role: 'admin',
      email: 'admin@example.edu',
      username: 'admin',
      is_active: true,
      locked_until: new Date(Date.now() + 60_000),
      comparePassword: jest.fn().mockResolvedValue(false),
      update: jest.fn()
    };
    User.findOne.mockResolvedValue(admin);
    const req = { body: { identifier: 'admin', password: 'wrong' } };
    const res = createResponse();

    await login(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Invalid credentials.' });
    expect(admin.update).not.toHaveBeenCalled();
  });

  test('does not count invalid secret-code attempts toward admin lockout', async () => {
    const admin = {
      id: 1,
      role: 'admin',
      email: 'admin@example.edu',
      username: 'admin',
      is_active: true,
      comparePassword: jest.fn().mockResolvedValue(true),
      compareSecretCode: jest.fn().mockResolvedValue(false),
      update: jest.fn()
    };
    User.findOne.mockResolvedValue(admin);
    const req = { body: { identifier: 'admin', password: 'correct', secretCode: 'wrong' } };
    const res = createResponse();

    await login(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Invalid secret access code.' });
    expect(admin.update).not.toHaveBeenCalled();
  });

  test('continues to enforce lockout for faculty accounts', async () => {
    const faculty = {
      id: 2,
      role: 'faculty',
      email: 'faculty@example.edu',
      is_active: true,
      locked_until: new Date(Date.now() + 60_000)
    };
    User.findOne.mockResolvedValue(faculty);
    const req = { body: { identifier: 'faculty', password: 'password' } };
    const res = createResponse();

    await login(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Account temporarily locked. Try again later or contact an administrator.'
    }));
  });
});
