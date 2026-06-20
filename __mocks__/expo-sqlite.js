module.exports = {
  openDatabaseAsync: jest.fn().mockResolvedValue({
    execAsync: jest.fn().mockResolvedValue({}),
    withExclusiveTransactionAsync: jest.fn(cb => cb()),
    withTransactionAsync: jest.fn(cb => cb()),
    prepareAsync: jest.fn(),
    getAllAsync: jest.fn().mockResolvedValue([]),
    getFirstAsync: jest.fn().mockResolvedValue({ user_version: 3 }),
    runAsync: jest.fn().mockResolvedValue({}),
  }),
};
