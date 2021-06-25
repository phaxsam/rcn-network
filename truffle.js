module.exports = {
  compilers: {
    solc: {
      version: '0.8.0',
      settings: {
        optimizer: {
          enabled: true,
          runs: 200,
        },
      },
    },
  },
  plugins: ['solidity-coverage'],
};
