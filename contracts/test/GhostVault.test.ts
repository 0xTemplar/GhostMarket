import { expect } from 'chai';
import { ethers } from 'hardhat';
import { GhostVault } from '../typechain-types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('GhostVault', function () {
  let vault: GhostVault;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let relayer: SignerWithAddress;
  let settlementSigner: SignerWithAddress;

  beforeEach(async () => {
    [owner, user, relayer, settlementSigner] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('GhostVault');
    vault = (await Factory.deploy(settlementSigner.address)) as GhostVault;
    await vault.waitForDeployment();
  });

  // ─── Deposit ─────────────────────────────────────────────────────────────

  it('records deposit from user', async () => {
    const amount = ethers.parseEther('1.0');
    await expect(vault.connect(user).deposit({ value: amount }))
      .to.emit(vault, 'Deposited')
      .withArgs(user.address, amount);
    expect(await vault.getBalance(user.address)).to.equal(amount);
  });

  it('rejects zero deposit', async () => {
    await expect(vault.connect(user).deposit({ value: 0 })).to.be.revertedWithCustomError(
      vault,
      'ZeroAmount'
    );
  });

  it('relayer can deposit on behalf of user (gasless path)', async () => {
    const amount = ethers.parseEther('2.0');
    await expect(vault.connect(relayer).depositFor(user.address, { value: amount }))
      .to.emit(vault, 'Deposited')
      .withArgs(user.address, amount);
    expect(await vault.getBalance(user.address)).to.equal(amount);
  });

  // ─── Withdraw ────────────────────────────────────────────────────────────

  it('allows user to withdraw their balance', async () => {
    const amount = ethers.parseEther('1.0');
    await vault.connect(user).deposit({ value: amount });
    const before = await ethers.provider.getBalance(user.address);
    const tx = await vault.connect(user).withdraw(amount);
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed * receipt!.gasPrice;
    const after = await ethers.provider.getBalance(user.address);
    expect(after).to.be.closeTo(before + amount - gas, ethers.parseEther('0.0001'));
  });

  it('rejects withdrawal exceeding balance', async () => {
    await vault.connect(user).deposit({ value: ethers.parseEther('0.5') });
    await expect(
      vault.connect(user).withdraw(ethers.parseEther('1.0'))
    ).to.be.revertedWithCustomError(vault, 'InsufficientBalance');
  });

  // ─── Payout claim ────────────────────────────────────────────────────────

  it('credits user balance on valid attested payout', async () => {
    const marketId = ethers.keccak256(ethers.toUtf8Bytes('market-001'));
    const amount = ethers.parseEther('5.0');
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const vaultAddress = await vault.getAddress();

    const msgHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'bytes32', 'uint256', 'uint256', 'uint256', 'address'],
        [user.address, marketId, amount, nonce, expiry, vaultAddress]
      )
    );
    const sig = await settlementSigner.signMessage(ethers.getBytes(msgHash));

    await expect(vault.connect(user).claimPayout(marketId, amount, nonce, expiry, sig))
      .to.emit(vault, 'PayoutClaimed')
      .withArgs(user.address, marketId, amount);

    expect(await vault.getBalance(user.address)).to.equal(amount);
  });

  it('rejects replayed payout nonce', async () => {
    const marketId = ethers.keccak256(ethers.toUtf8Bytes('market-002'));
    const amount = ethers.parseEther('1.0');
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const vaultAddress = await vault.getAddress();

    const msgHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'bytes32', 'uint256', 'uint256', 'uint256', 'address'],
        [user.address, marketId, amount, nonce, expiry, vaultAddress]
      )
    );
    const sig = await settlementSigner.signMessage(ethers.getBytes(msgHash));

    await vault.connect(user).claimPayout(marketId, amount, nonce, expiry, sig);
    await expect(
      vault.connect(user).claimPayout(marketId, amount, nonce, expiry, sig)
    ).to.be.revertedWithCustomError(vault, 'NonceAlreadyUsed');
  });

  it('rejects expired payout', async () => {
    const marketId = ethers.keccak256(ethers.toUtf8Bytes('market-003'));
    const amount = ethers.parseEther('1.0');
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) - 1; // already expired
    const vaultAddress = await vault.getAddress();

    const msgHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'bytes32', 'uint256', 'uint256', 'uint256', 'address'],
        [user.address, marketId, amount, nonce, expiry, vaultAddress]
      )
    );
    const sig = await settlementSigner.signMessage(ethers.getBytes(msgHash));

    await expect(
      vault.connect(user).claimPayout(marketId, amount, nonce, expiry, sig)
    ).to.be.revertedWithCustomError(vault, 'PayoutExpired');
  });

  // ─── Owner admin ─────────────────────────────────────────────────────────

  it('owner can rotate settlement signer', async () => {
    await expect(vault.connect(owner).setSettlementSigner(relayer.address))
      .to.emit(vault, 'SettlementSignerUpdated')
      .withArgs(settlementSigner.address, relayer.address);
    expect(await vault.settlementSigner()).to.equal(relayer.address);
  });

  it('non-owner cannot rotate settlement signer', async () => {
    await expect(
      vault.connect(user).setSettlementSigner(user.address)
    ).to.be.revertedWithCustomError(vault, 'Unauthorised');
  });
});
