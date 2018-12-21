const ReferenceCosigner = artifacts.require('./examples/ReferenceCosigner.sol');

const DebtEngine = artifacts.require('./diaspore/DebtEngine.sol');
const LoanManager = artifacts.require('./diaspore/LoanManager.sol');
const TestModel = artifacts.require('./diaspore/utils/test/TestModel.sol');
const TestToken = artifacts.require('./utils/test/TestToken.sol');
const TestReferenceCosigner = artifacts.require('./utils/test/TestReferenceCosigner.sol');
const TestLoanManagerForReferenceCosigner = artifacts.require('./utils/test/TestLoanManagerForReferenceCosigner.sol');

const TestRateOracle = artifacts.require('./utils/test/TestRateOracle.sol');

const Helper = require('./Helper.js');
const Web3Utils = require('web3-utils');
const BigNumber = web3.BigNumber;

require('chai')
    .use(require('chai-bignumber')(BigNumber))
    .should();

function bn (number) {
    if (typeof number != 'string') {
        number = number.toString();
    }
    return new BigNumber(number);
}

function maxUint (base) {
    return bn('2').pow(bn(base)).sub(bn('1'));
}

contract('Test ReferenceCosigner Diaspore', function (accounts) {
    const owner = accounts[9];

    let rcn;
    let debtEngine;
    let loanManager;
    let model;
    let cosigner;
    let testCosigner;
    let testLoanManager;
    let oracle;
    let cosignerEvents;

    function getAllEvents (contract) {
        function toEvent (crudeEvent) {
            return {
                name: crudeEvent.name,
                inputs: crudeEvent.inputs,
                topic: Web3Utils.soliditySha3(crudeEvent.name + '(' + crudeEvent.inputs.map(x => x.type) + ')'),
            };
        }

        const crudeEvents = contract.abi.filter(x => x.type === 'event');
        return crudeEvents.map(x => toEvent(x));
    }

    async function toDataRequestCosign (cosignerContract, loanManagerContract, id, cost, coverage, requiredArrears, expiration, signer) {
        const hashDataSignature = await cosignerContract.hashDataSignature(
            loanManagerContract.address,
            id,
            cost,
            coverage,
            requiredArrears,
            expiration
        );

        const signature = await web3.eth.sign(signer, hashDataSignature).slice(2);
        const r = signature.slice(0, 64);
        const s = signature.slice(64, 128);
        const v = Web3Utils.toHex(web3.toDecimal(signature.slice(128, 130)) + 27).slice(2);

        return (await cosignerContract.encodeData(cost, coverage, requiredArrears, expiration)) + v + r + s;
    };

    before('Create contracts', async function () {
        rcn = await TestToken.new({ from: owner });
        debtEngine = await DebtEngine.new(rcn.address, { from: owner });
        loanManager = await LoanManager.new(debtEngine.address, { from: owner });
        testLoanManager = await TestLoanManagerForReferenceCosigner.new({ from: owner });
        model = await TestModel.new({ from: owner });
        await model.setEngine(debtEngine.address, { from: owner });
        oracle = await TestRateOracle.new({ from: owner });
        testCosigner = await TestReferenceCosigner.new(rcn.address, { from: owner });
        cosigner = await ReferenceCosigner.new(rcn.address, { from: owner });
        cosignerEvents = getAllEvents(cosigner);

        assert.equal(await cosigner.rcn(), rcn.address);
    });

    beforeEach('Clean', async function () {
        async function resetBal (spender) {
            if ((await rcn.balanceOf(spender)).toString() !== '0') {
                await rcn.setBalance(spender, bn('0'));
            }
        }

        async function resetApprove (spender, sender) {
            if ((await rcn.allowance(sender, spender)).toString() !== '0') {
                await rcn.approve(spender, bn('0'), { from: sender });
            }
        }

        for (let i = 0; i < accounts.length; i++) {
            await cosigner.removeDelegate(accounts[i], { from: owner });
            await testCosigner.removeDelegate(accounts[i], { from: owner });
            await resetBal(accounts[i]);
            await resetApprove(loanManager.address, accounts[i]);
            await resetApprove(testLoanManager.address, accounts[i]);
            await resetApprove(debtEngine.address, accounts[i]);
            await resetApprove(cosigner.address, accounts[i]);
        }
        await resetBal(cosigner.address);
        await resetBal(loanManager.address);
        await resetBal(debtEngine.address);

        (await rcn.totalSupply()).should.be.bignumber.equal(bn('0'));
    });

    describe('Helper contract', async () => {
        const signer = accounts[7];

        it('Should encode and decode data and signature', async () => {
            const cost = bn('1000');
            const coverage = bn('6000');
            const requiredArrears = bn('666');
            const expiration = bn(await Helper.getBlockTime());
            const id = bn('51651');

            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                cost,
                coverage,
                requiredArrears,
                expiration,
                signer
            );

            const decodedData = await testCosigner.decodeCosignerData(data);
            (decodedData[0]).should.be.bignumber.equal(cost);
            (decodedData[1]).should.be.bignumber.equal(coverage);
            (decodedData[2]).should.be.bignumber.equal(requiredArrears);
            (decodedData[3]).should.be.bignumber.equal(expiration);

            const msg = await cosigner.hashDataSignature(loanManager.address, id, cost, coverage, requiredArrears, expiration);
            const signature = await web3.eth.sign(signer, msg).slice(2);
            const r = signature.slice(0, 64);
            const s = signature.slice(64, 128);
            const v = web3.toDecimal(signature.slice(128, 130)) + 27;

            assert.equal(data.slice(-130, -128), Web3Utils.toHex(v).slice(-2));
            assert.equal(data.slice(-128, -64), r);
            assert.equal(data.slice(-64), s);
        });

        it('Try decode a cosign data with invalid length', async () => {
            const cost = bn('1000');
            const coverage = bn('6000');
            const requiredArrears = bn('5652');
            const expiration = bn(await Helper.getBlockTime());
            const id = bn('51651');

            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                cost,
                coverage,
                requiredArrears,
                expiration,
                signer
            );

            await Helper.tryCatchRevert(
                () => testCosigner.decodeCosignerData(
                    data + '00'
                ),
                'Invalid data length'
            );

            await Helper.tryCatchRevert(
                () => testCosigner.decodeCosignerData(
                    data.slice(0, 4)
                ),
                'Invalid data length'
            );
        });

        it('Should encode data', async () => {
            const maxData = await cosigner.encodeData(
                maxUint('128'),
                maxUint('16'),
                maxUint('64'),
                maxUint('64')
            );

            assert.equal(maxData.slice(2, 34), 'ffffffffffffffffffffffffffffffff');
            assert.equal(maxData.slice(34, 38), 'ffff');
            assert.equal(maxData.slice(38, 54), 'ffffffffffffffff');
            assert.equal(maxData.slice(54, 70), 'ffffffffffffffff');

            const cost = bn('265987451657894324156789798132164544191');
            const coverage = bn('59842');
            const requiredArrears = bn('226547874984564984');
            const expiration = bn('12559879816516548948');

            const data = await cosigner.encodeData(
                cost,
                coverage,
                requiredArrears,
                expiration
            );

            assert.equal(data.slice(2, 34), 'c81b51de46c3dd16602ebe13a15f46bf');
            assert.equal(data.slice(34, 38), 'e9c2');
            assert.equal(data.slice(38, 54), '0324dc178d1318f8');
            assert.equal(data.slice(54, 70), 'ae4da825e5113954');
        });
    });

    describe('function url and setUrl', async () => {
        it('Should set url', async () => {
            const url = 'https://rcn.cosigner/';

            assert.equal(await cosigner.url(), '');

            const SetUrl = await Helper.toEvent(
                cosigner.setUrl(url, { from: owner }),
                'SetUrl'
            );

            assert.equal(SetUrl._url, url);
            assert.equal(await cosigner.url(), url);
        });

        it('Try set url without ownership', async () => {
            await Helper.tryCatchRevert(
                () => cosigner.setUrl('TEST', { from: accounts[8] }),
                'The owner should be the sender'
            );
        });
    });

    describe('function cost', async () => {
        const signer = accounts[7];

        it('Consult cost of data', async () => {
            const cost = bn('1222');
            const coverage = bn('6000');
            const requiredArrears = bn('512');
            const expiration = bn(await Helper.getBlockTime());
            const id = bn('898');

            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                cost,
                coverage,
                requiredArrears,
                expiration,
                signer
            );

            const costData = await cosigner.cost(
                Helper.address0x,
                bn('0'),
                data,
                Helper.address0x
            );

            costData.should.be.bignumber.equal(cost);
        });
    });

    describe('function requestCosign', async () => {
        const signer = accounts[7];

        it('Request a cosign on a loan', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('1031230');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6000');
            const requiredArrears = ('524');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            const tx = await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );
            const eventTopic = cosignerEvents.find(x => x.name === 'Cosign').topic;
            const event = tx.receipt.logs.find(x => x.topics.some(y => y === eventTopic));

            assert.equal(event.topics[1], id);

            assert.equal(
                event.data.slice(2, 130),
                Helper.toBytes32(loanManager.address).slice(2) +
                Helper.toBytes32(signer).slice(2)
            );
            const liability = await cosigner.liabilities(loanManager.address, id);

            liability[0].should.be.bignumber.equal(coverage);
            liability[1].should.be.bignumber.equal(requiredArrears);
        });

        it('Try requestCosign with different _loanManager parameter and msg.sender', async () => {
            const borrower = accounts[1];
            const amount = bn('66666');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6000');
            const requiredArrears = bn('500');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await Helper.tryCatchRevert(
                () => cosigner.requestCosign(
                    accounts[5],
                    id,
                    data,
                    '',
                    { from: accounts[4] }
                ),
                'The msg.sender should be the loanManager'
            );
        });

        it('Try cosign two times the same loan', async () => {
            const id = bn('98489498');

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                testLoanManager,
                id,
                bn('0'),
                bn('6000'),
                await Helper.getBlockTime() + 500,
                await Helper.getBlockTime() + 1000,
                signer
            );

            await testLoanManager.requestCosign(
                id,
                cosigner.address,
                data
            );

            await Helper.tryCatchRevert(
                () => testLoanManager.requestCosign(
                    id,
                    cosigner.address,
                    data
                ),
                'The liability exist'
            );
        });

        it('Try cosign an expired data', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('66451');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6000');
            const requiredArrears = bn('662');
            const expirationCosign = bn('0');

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await Helper.tryCatchRevert(
                () => loanManager.lend(
                    id,
                    [],
                    cosigner.address,
                    costCosign,
                    data,
                    { from: lender }
                ),
                'The data of requestCosign its expired'
            );
        });

        it('Try cosign a loan with coverage equal 0', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('66451');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('662'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('0');
            const requiredArrears = bn('666');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await Helper.tryCatchRevert(
                () => loanManager.lend(
                    id,
                    [],
                    cosigner.address,
                    costCosign,
                    data,
                    { from: lender }
                ),
                'The coverage should not be 0'
            );
        });

        it('Try cosign a loan without being a delegate', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('698452');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6552');
            const requiredArrears = bn('6632');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            const noSigner = accounts[2];
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                noSigner
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await Helper.tryCatchRevert(
                () => loanManager.lend(
                    id,
                    [],
                    cosigner.address,
                    costCosign,
                    data,
                    { from: lender }
                ),
                'The signer its not a delegate'
            );
        });

        it('Try request cosign and the cosign function return false', async () => {
            const id = bn('382137');

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                testLoanManager,
                id,
                bn('1'),
                bn('5561'),
                await Helper.getBlockTime() + 500,
                await Helper.getBlockTime() + 1000,
                signer
            );

            await Helper.tryCatchRevert(
                () => testLoanManager.requestCosign(
                    id,
                    cosigner.address,
                    data
                ),
                'Fail loanManager cosign'
            );
        });
    });

    describe('function isDefaulted', async () => {
        const signer = accounts[7];

        it('The liability should not be defaulted', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('98875');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6562');
            const requiredArrears = bn('500');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );

            assert.equal(await cosigner.isDefaulted(loanManager.address, id), false);
        });

        it('The liability should not be defaulted (liability non-expired and status paid)', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('98875');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('223'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6562');
            const requiredArrears = bn('500');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );

            await rcn.setBalance(borrower, amount.plus(amount));
            await rcn.approve(debtEngine.address, amount.plus(amount), { from: borrower });

            await debtEngine.pay(
                id,
                amount.plus(amount),
                borrower,
                [],
                { from: borrower }
            );
            (await model.getStatus(id)).should.be.bignumber.equal(bn('2'));

            assert.equal(await cosigner.isDefaulted(loanManager.address, id), false);
        });

        it('The liability should not be defaulted (liability expired and status paid)', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('98875');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6562');
            const requiredArrears = bn('33');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );

            await rcn.setBalance(borrower, amount.plus(amount));
            await rcn.approve(debtEngine.address, amount.plus(amount), { from: borrower });

            await debtEngine.pay(
                id,
                amount.plus(amount),
                borrower,
                [],
                { from: borrower }
            );
            (await model.getStatus(id)).should.be.bignumber.equal(bn('2'));

            await Helper.increaseTime(3000);

            assert.equal(await cosigner.isDefaulted(loanManager.address, id), false);
        });

        it('The liability should be defaulted (liability expired and status non-paid)', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('98875');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6562');
            const requiredArrears = bn('500');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );

            await Helper.increaseTime(3000);

            assert.equal(await cosigner.isDefaulted(loanManager.address, id), true);
        });
    });

    describe('function _currencyToToken', async () => {
        it('Use RCN Token as currency', async () => {
            const amount = bn('516516');
            const tokens = await testCosigner.currencyToToken(
                Helper.address0x,
                amount,
                []
            );

            tokens.should.be.bignumber.equal(amount);
        });

        it('Use ARS as currency', async () => {
            const ars = bn('5516512');
            const amount = bn('4');
            const equivalent = bn('8');
            const oracleData = await oracle.encodeRate(amount, equivalent);
            const constTokens = ars.mul(amount).div(equivalent);

            const rcnTokens = await testCosigner.currencyToToken(
                oracle.address,
                ars,
                oracleData
            );

            rcnTokens.should.be.bignumber.equal(constTokens);
        });
    });

    describe('function claim', async () => {
        const signer = accounts[7];

        it('Should claim a liability', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('626232');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6562');
            const requiredArrears = bn('500');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );

            await Helper.increaseTime(3000);

            await rcn.setBalance(cosigner.address, amount);
            await debtEngine.approve(cosigner.address, id, { from: lender });

            const prevCosignerBal = await rcn.balanceOf(cosigner.address);
            const prevLenderBal = await rcn.balanceOf(lender);

            const events = await Helper.toEvent(
                cosigner.claim(
                    loanManager.address,
                    id,
                    '',
                    { from: lender }
                ),
                'Claim',
                'Received'
            );
            const calcClaimAmount = coverage.mul(await loanManager.getClosingObligation(id)).dividedToIntegerBy(bn('10000'));

            const Claim = events[0];
            assert.equal(Claim._loanManager, loanManager.address);
            assert.equal(Claim._index, id);
            assert.equal(Claim._sender, lender);
            Claim._claimAmount.should.be.bignumber.equal(calcClaimAmount);
            assert.equal(Claim._oracleData, '0x');

            const Received = events[1];
            assert.equal(Received._operator, cosigner.address);
            assert.equal(Received._from, lender);
            Received._id.should.be.bignumber.equal(id);
            assert.equal(Received._data, '0x');

            const liability = await cosigner.liabilities(loanManager.address, id);
            liability[0].should.be.bignumber.equal(bn('0'));
            liability[1].should.be.bignumber.equal(requiredArrears);

            assert.equal(await debtEngine.ownerOf(id), cosigner.address);
            (await rcn.balanceOf(cosigner.address)).should.be.bignumber.equal(prevCosignerBal.sub(calcClaimAmount));
            (await rcn.balanceOf(lender)).should.be.bignumber.equal(prevLenderBal.plus(calcClaimAmount));
        });

        it('Try claim a non-existent liability', async () => {
            await Helper.tryCatchRevert(
                () => cosigner.claim(
                    loanManager.address,
                    bn('25131651'),
                    '',
                    { from: accounts[2] }
                ),
                'The liability not exists'
            );
        });

        it('Try claim a liability with borrower as msg.sender', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('626232');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6562');
            const requiredArrears = bn('500');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );

            await Helper.increaseTime(3000);

            await rcn.setBalance(cosigner.address, amount);
            await debtEngine.approve(cosigner.address, id, { from: lender });

            await Helper.tryCatchRevert(
                () => cosigner.claim(
                    loanManager.address,
                    id,
                    '',
                    { from: borrower }
                ),
                'The msg.sender should be the owner of the loan'
            );
        });

        it('Try claim a liability and cosigner contract dont have token balance', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('626232');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6562');
            const requiredArrears = bn('500');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );

            await Helper.increaseTime(3000);

            await debtEngine.approve(cosigner.address, id, { from: lender });

            await Helper.tryCatchRevert(
                () => cosigner.claim(
                    loanManager.address,
                    id,
                    '',
                    { from: lender }
                ),
                'Error paying the cosigner'
            );
        });

        it('Try claim a liability and cosigner contract dont have token balance', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('626232');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6562');
            const requiredArrears = bn('500');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );

            await Helper.increaseTime(3000);

            await rcn.setBalance(cosigner.address, amount);

            await Helper.tryCatchRevert(
                () => cosigner.claim(
                    loanManager.address,
                    id,
                    '',
                    { from: lender }
                ),
                'msg.sender Not authorized'
            );
        });

        it('Try claim a non-defaulted liability (liability non-expired and status paid)', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('626232');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6562');
            const requiredArrears = bn('500');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );

            await rcn.setBalance(cosigner.address, amount);
            await debtEngine.approve(cosigner.address, id, { from: lender });

            await rcn.setBalance(borrower, amount.plus(amount));
            await rcn.approve(debtEngine.address, amount.plus(amount), { from: borrower });

            await debtEngine.pay(
                id,
                amount.plus(amount),
                borrower,
                [],
                { from: borrower }
            );

            await Helper.tryCatchRevert(
                () => cosigner.claim(
                    loanManager.address,
                    id,
                    '',
                    { from: lender }
                ),
                'The liability is not defaulted'
            );
        });

        it('Try claim a non-defaulted liability (liability expired and status paid)', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('626232');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6562');
            const requiredArrears = bn('500');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );

            await Helper.increaseTime(3000);

            await rcn.setBalance(cosigner.address, amount);
            await debtEngine.approve(cosigner.address, id, { from: lender });

            await rcn.setBalance(borrower, amount.plus(amount));
            await rcn.approve(debtEngine.address, amount.plus(amount), { from: borrower });

            await debtEngine.pay(
                id,
                amount.plus(amount),
                borrower,
                [],
                { from: borrower }
            );

            await Helper.tryCatchRevert(
                () => cosigner.claim(
                    loanManager.address,
                    id,
                    '',
                    { from: lender }
                ),
                'The liability is not defaulted'
            );
        });
    });

    describe('function withdrawFromLoan', async () => {
        const signer = accounts[7];

        it('Should withdraw all founds of a loan', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const receiver = accounts[3];
            const amount = bn('626232');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6562');
            const requiredArrears = bn('500');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );

            await Helper.increaseTime(3000);

            await rcn.setBalance(cosigner.address, amount);
            await debtEngine.approve(cosigner.address, id, { from: lender });

            await cosigner.claim(
                loanManager.address,
                id,
                '',
                { from: lender }
            );

            await rcn.setBalance(borrower, amount);
            await rcn.approve(debtEngine.address, amount, { from: borrower });

            await debtEngine.pay(
                id,
                amount,
                borrower,
                [],
                { from: borrower }
            );

            const prevCosignerBal = await rcn.balanceOf(cosigner.address);
            const prevLoanBal = (await debtEngine.debts(id))[1];

            await cosigner.withdrawFromLoan(
                loanManager.address,
                id,
                receiver,
                { from: owner }
            );

            assert.equal(await debtEngine.ownerOf(id), cosigner.address);
            (await rcn.balanceOf(cosigner.address)).should.be.bignumber.equal(prevCosignerBal);
            (await rcn.balanceOf(receiver)).should.be.bignumber.equal(prevLoanBal);
            ((await debtEngine.debts(id))[1]).should.be.bignumber.equal(bn('0'));
        });

        it('Try withdraw all founds of a loan without ownership', async () => {
            await Helper.tryCatchRevert(
                () => cosigner.withdrawFromLoan(
                    loanManager.address,
                    bn('6661221'),
                    Helper.address0x,
                    { from: accounts[3] }
                ),
                'The owner should be the sender'
            );
        });

        it('Try withdraw all founds of a loan to address 0x0', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('626232');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6562');
            const requiredArrears = bn('500');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );

            await Helper.increaseTime(3000);

            await rcn.setBalance(cosigner.address, amount);
            await debtEngine.approve(cosigner.address, id, { from: lender });

            await cosigner.claim(
                loanManager.address,
                id,
                '',
                { from: lender }
            );

            await rcn.setBalance(borrower, amount);
            await rcn.approve(debtEngine.address, amount, { from: borrower });

            await debtEngine.pay(
                id,
                amount,
                borrower,
                [],
                { from: borrower }
            );

            await Helper.tryCatchRevert(
                () => cosigner.withdrawFromLoan(
                    loanManager.address,
                    id,
                    Helper.address0x,
                    { from: owner }
                ),
                'Invalid _to address'
            );
        });
    });

    describe('function withdrawBatch', async () => {
        const borrower = accounts[1];
        const lender = accounts[2];
        const receiver = accounts[3];
        const signer = accounts[7];
        const amount = bn('626232');
        // For cosign
        const costCosign = bn('1222');
        const coverage = bn('6562');
        const requiredArrears = bn('20');
        const totalLoans = 5;

        it('Should withdraw all founds of a batch of loans', async () => {
            const ids = [];
            const expirationCosign = await Helper.getBlockTime() + 20;
            const expirationLoan = await Helper.getBlockTime() + 20;

            await rcn.setBalance(lender, amount.plus(costCosign).mul(totalLoans));
            await cosigner.addDelegate(signer, { from: owner });
            // set balance to the lender
            await rcn.approve(loanManager.address, amount.plus(costCosign).mul(totalLoans), { from: lender });
            // Create loans
            for (let i = 0; i < totalLoans; i++) {
                const id = (await Helper.toEvent(
                    loanManager.requestLoan(
                        amount,
                        model.address,
                        Helper.address0x,
                        borrower,
                        i,
                        expirationLoan,
                        await model.encodeData(amount, expirationLoan),
                        { from: borrower }
                    ),
                    'Requested'
                ))._id;

                ids.push(id);
                const data = await toDataRequestCosign(
                    cosigner,
                    loanManager,
                    id,
                    costCosign,
                    coverage,
                    requiredArrears,
                    expirationCosign,
                    signer
                );

                await loanManager.lend(
                    id,
                    [],
                    cosigner.address,
                    costCosign,
                    data,
                    { from: lender }
                );
            }
            // Claim loans
            await Helper.increaseTime(60);
            await rcn.setBalance(cosigner.address, amount.mul(totalLoans));
            for (let i = 0; i < totalLoans; i++) {
                await debtEngine.approve(cosigner.address, ids[i], { from: lender });
                await cosigner.claim(
                    loanManager.address,
                    ids[i],
                    '',
                    { from: lender }
                );
            }
            // Pay loans
            await rcn.setBalance(borrower, amount.mul(totalLoans));
            await rcn.approve(debtEngine.address, amount.mul(totalLoans), { from: borrower });
            let totalWithdraw = 0;
            for (let i = 0; i < totalLoans; i++) {
                totalWithdraw += i;
                await debtEngine.pay(
                    ids[i],
                    i,
                    borrower,
                    [],
                    { from: borrower }
                );
            }

            const prevCosignerBal = await rcn.balanceOf(cosigner.address);
            const prevReceiverBal = await rcn.balanceOf(receiver);

            await cosigner.withdrawBatchLoans(
                loanManager.address,
                ids,
                receiver,
                { from: owner }
            );

            (await rcn.balanceOf(cosigner.address)).should.be.bignumber.equal(prevCosignerBal);
            (await rcn.balanceOf(receiver)).should.be.bignumber.equal(prevReceiverBal.plus(bn(totalWithdraw)));
        });

        it('Try withdraw all founds of a loan to address 0x0', async () => {
            await Helper.tryCatchRevert(
                () => cosigner.withdrawBatchLoans(
                    loanManager.address,
                    [],
                    Helper.address0x,
                    { from: owner }
                ),
                'Invalid _to address'
            );
        });
    });

    describe('function withdrawPartialFromLoan', async () => {
        const signer = accounts[7];

        it('Should withdraw partial funds from a loan', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const receiver = accounts[3];
            const amount = bn('626232');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6562');
            const requiredArrears = bn('500');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );

            await Helper.increaseTime(3000);

            await rcn.setBalance(cosigner.address, amount);
            await debtEngine.approve(cosigner.address, id, { from: lender });

            await cosigner.claim(
                loanManager.address,
                id,
                '',
                { from: lender }
            );

            await rcn.setBalance(borrower, amount);
            await rcn.approve(debtEngine.address, amount, { from: borrower });

            await debtEngine.pay(
                id,
                amount,
                borrower,
                [],
                { from: borrower }
            );

            const prevCosignerBal = await rcn.balanceOf(cosigner.address);
            const withdrawAmount = bn('652');

            await cosigner.withdrawPartialFromLoan(
                loanManager.address,
                id,
                receiver,
                withdrawAmount,
                { from: owner }
            );

            assert.equal(await debtEngine.ownerOf(id), cosigner.address);
            (await rcn.balanceOf(cosigner.address)).should.be.bignumber.equal(prevCosignerBal);
            (await rcn.balanceOf(receiver)).should.be.bignumber.equal(withdrawAmount);
        });

        it('Try withdraw partial founds of a loan without ownership', async () => {
            await Helper.tryCatchRevert(
                () => cosigner.withdrawPartialFromLoan(
                    loanManager.address,
                    bn('6661221'),
                    Helper.address0x,
                    bn('65566'),
                    { from: accounts[3] }
                ),
                'The owner should be the sender'
            );
        });

        it('Try withdraw partial funds from a loan to address 0x0', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('626232');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6562');
            const requiredArrears = bn('500');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );

            await Helper.increaseTime(3000);

            await rcn.setBalance(cosigner.address, amount);
            await debtEngine.approve(cosigner.address, id, { from: lender });

            await cosigner.claim(
                loanManager.address,
                id,
                '',
                { from: lender }
            );

            await rcn.setBalance(borrower, amount);
            await rcn.approve(debtEngine.address, amount, { from: borrower });

            await debtEngine.pay(
                id,
                amount,
                borrower,
                [],
                { from: borrower }
            );

            const withdrawAmount = bn('3332');

            await Helper.tryCatchRevert(
                () => cosigner.withdrawPartialFromLoan(
                    loanManager.address,
                    id,
                    Helper.address0x,
                    withdrawAmount,
                    { from: owner }
                ),
                'Invalid _to address'
            );
        });
    });

    describe('function transferLoan', async () => {
        const signer = accounts[7];

        it('Should transfers a loan to a new owner', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const receiver = accounts[3];
            const amount = bn('626232');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6562');
            const requiredArrears = bn('500');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );

            await Helper.increaseTime(3000);

            await rcn.setBalance(cosigner.address, amount);
            await debtEngine.approve(cosigner.address, id, { from: lender });

            await cosigner.claim(
                loanManager.address,
                id,
                '',
                { from: lender }
            );

            assert.equal(await debtEngine.ownerOf(id), cosigner.address);

            await cosigner.transferLoan(
                loanManager.address,
                id,
                receiver,
                { from: owner }
            );

            assert.equal(await debtEngine.ownerOf(id), receiver);
        });

        it('Try transfers a loan to a new owner without ownership', async () => {
            await Helper.tryCatchRevert(
                () => cosigner.transferLoan(
                    loanManager.address,
                    bn('6661221'),
                    accounts[3],
                    { from: accounts[3] }
                ),
                'The owner should be the sender'
            );
        });

        it('Try transfers a loan to address 0x0', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('626232');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6562');
            const requiredArrears = bn('500');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );

            await Helper.increaseTime(3000);

            await rcn.setBalance(cosigner.address, amount);
            await debtEngine.approve(cosigner.address, id, { from: lender });

            await cosigner.claim(
                loanManager.address,
                id,
                '',
                { from: lender }
            );

            assert.equal(await debtEngine.ownerOf(id), cosigner.address);

            await Helper.tryCatchRevert(
                () => cosigner.transferLoan(
                    loanManager.address,
                    id,
                    Helper.address0x,
                    { from: owner }
                ),
                'Target can\'t be 0x0'
            );

            assert.equal(await debtEngine.ownerOf(id), cosigner.address);
        });

        it('Try transfers a loan and the liability non-exists', async () => {
            const id = bn('56565161619498');

            await Helper.tryCatchRevert(
                () => cosigner.transferLoan(
                    loanManager.address,
                    id,
                    accounts[3],
                    { from: owner }
                ),
                'msg.sender Not authorized'
            );
        });

        it('Try transfers a loan and the liability is not claimed', async () => {
            const borrower = accounts[1];
            const lender = accounts[2];
            const amount = bn('626232');
            const expirationLoan = await Helper.getBlockTime() + 1000;

            const id = (await Helper.toEvent(
                loanManager.requestLoan(
                    amount,
                    model.address,
                    Helper.address0x,
                    borrower,
                    bn('1'),
                    expirationLoan,
                    await model.encodeData(amount, expirationLoan),
                    { from: borrower }
                ),
                'Requested'
            ))._id;

            const costCosign = bn('1222');
            const coverage = bn('6562');
            const requiredArrears = bn('500');
            const expirationCosign = await Helper.getBlockTime() + 1000;

            await cosigner.addDelegate(signer, { from: owner });
            const data = await toDataRequestCosign(
                cosigner,
                loanManager,
                id,
                costCosign,
                coverage,
                requiredArrears,
                expirationCosign,
                signer
            );

            await rcn.setBalance(lender, amount.plus(costCosign));
            await rcn.approve(loanManager.address, amount.plus(costCosign), { from: lender });

            await loanManager.lend(
                id,
                [],
                cosigner.address,
                costCosign,
                data,
                { from: lender }
            );

            await Helper.increaseTime(3000);

            await rcn.setBalance(cosigner.address, amount);
            await debtEngine.approve(cosigner.address, id, { from: lender });

            await Helper.tryCatchRevert(
                () => cosigner.transferLoan(
                    loanManager.address,
                    id,
                    accounts[3],
                    { from: owner }
                ),
                'The liability is not claimed'
            );
        });
    });

    describe('function withdrawPartial', async () => {
        it('Should withdraw partial funds from the contract', async () => {
            const tokenSender = accounts[2];
            const receiver = accounts[3];
            const amount = bn('100000000');
            const withdrawAmount = amount.dividedToIntegerBy(bn('2'));

            await rcn.setBalance(tokenSender, amount);
            await rcn.transfer(cosigner.address, amount, { from: tokenSender });

            const prevCosignerBal = await rcn.balanceOf(cosigner.address);
            const prevReceiverBal = await rcn.balanceOf(receiver);

            await cosigner.withdrawPartial(
                rcn.address,
                receiver,
                withdrawAmount,
                { from: owner }
            );

            (await rcn.balanceOf(cosigner.address)).should.be.bignumber.equal(prevCosignerBal.sub(withdrawAmount));
            (await rcn.balanceOf(receiver)).should.be.bignumber.equal(prevReceiverBal.plus(withdrawAmount));
        });

        it('Try withdraw partial funds from the contract without ownership', async () => {
            await Helper.tryCatchRevert(
                () => cosigner.withdrawPartial(
                    rcn.address,
                    accounts[3],
                    bn('652652'),
                    { from: accounts[3] }
                ),
                'The owner should be the sender'
            );
        });

        it('Try withdraw a larger amount of the available', async () => {
            const tokenSender = accounts[2];
            const receiver = accounts[3];
            const amount = bn('51651');
            const withdrawAmount = amount.mul(bn('2'));

            await rcn.setBalance(tokenSender, amount);
            await rcn.transfer(cosigner.address, amount, { from: tokenSender });

            await Helper.tryCatchRevert(
                () => cosigner.withdrawPartial(
                    rcn.address,
                    receiver,
                    withdrawAmount,
                    { from: owner }
                ),
                'Error transfer tokens in withdrawal'
            );
        });

        it('Try withdraw token to address 0x0', async () => {
            const tokenSender = accounts[2];
            const amount = bn('51651');
            const withdrawAmount = amount.dividedToIntegerBy(bn('2'));

            await rcn.setBalance(tokenSender, amount);

            await rcn.transfer(cosigner.address, amount, { from: tokenSender });

            await Helper.tryCatchRevert(
                () => cosigner.withdrawPartial(
                    rcn.address,
                    Helper.address0x,
                    withdrawAmount,
                    { from: owner }
                ),
                'Invalid _to address'
            );
        });
    });
});
