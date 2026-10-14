jest.mock('../backend/models', () => ({
  User: {
    findOne: jest.fn(),
    findByPk: jest.fn(),
    create: jest.fn()
  },
  PrintLog: {},
  Report: {},
  AuditLog: {}
}));

jest.mock('../backend/utils/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../backend/services/emailService', () => ({
  sendFacultyInvitation: jest.fn().mockResolvedValue(undefined),
  sendAdminInvitation: jest.fn().mockResolvedValue(undefined)
}));

const { User } = require('../backend/models');
const { createUser, updateUser } = require('../backend/controllers/adminController');

const createResponse = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const facultyRequest = (body) => ({
  user: { id: 10, role: 'admin', department: 'Physics', email: 'admin@example.edu' },
  body
});

describe('department admin faculty access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects creating faculty in another department', async () => {
    const req = facultyRequest({
      name: 'Faculty Member',
      email: 'faculty@example.edu',
      password: 'password123',
      role: 'faculty',
      department: 'Chemistry'
    });
    const res = createResponse();

    await createUser(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(User.create).not.toHaveBeenCalled();
  });

  test('assigns the admin department when creating faculty without a department', async () => {
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue({
      id: 20,
      toSafeObject: () => ({ id: 20, department: 'Physics' })
    });
    const req = facultyRequest({
      name: 'Faculty Member',
      email: 'faculty@example.edu',
      password: 'password123',
      role: 'faculty'
    });
    const res = createResponse();

    await createUser(req, res);

    expect(User.create).toHaveBeenCalledWith(expect.objectContaining({ department: 'Physics' }));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('rejects moving faculty to another department', async () => {
    const faculty = { id: 20, role: 'faculty', department: 'Physics' };
    User.findByPk.mockResolvedValue(faculty);
    const req = facultyRequest({ department: 'Chemistry' });
    req.params = { id: 20 };
    const res = createResponse();

    await updateUser(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(faculty.update).toBeUndefined();
  });
});
