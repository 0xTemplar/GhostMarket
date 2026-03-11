import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
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
    const expiry = (await time.latest()) + 3600;
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
    const expiry = (await time.latest()) + 3600;
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
    const expiry = (await time.latest()) - 1; // already expired
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
    ).to.be.revertedWithCustomError(vault, 'OwnableUnauthorizedAccount');
  });

  it('setSettlementSigner reverts on zero address', async () => {
    await expect(
      vault.connect(owner).setSettlementSigner(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(vault, 'ZeroAddress');
  });

  it('Ownable2Step: new owner must accept before transfer completes', async () => {
    await vault.transferOwnership(user.address);
    expect(await vault.owner()).to.equal(owner.address); // still old owner
    await vault.connect(user).acceptOwnership();
    expect(await vault.owner()).to.equal(user.address);
  });

  it('pause blocks deposit', async () => {
    await vault.connect(owner).pause();
    await expect(
      vault.connect(user).deposit({ value: ethers.parseEther('1') })
    ).to.be.revertedWithCustomError(vault, 'EnforcedPause');
  });

  it('pause blocks withdraw', async () => {
    await vault.connect(user).deposit({ value: ethers.parseEther('1') });
    await vault.connect(owner).pause();
    await expect(
      vault.connect(user).withdraw(ethers.parseEther('1'))
    ).to.be.revertedWithCustomError(vault, 'EnforcedPause');
  });

  // ─── Collateral locking ───────────────────────────────────────────────────

  describe('lockForBet', () => {
    const MARKET_ID = ethers.keccak256(ethers.toUtf8Bytes('market-lock-001'));
    const DEPOSIT   = ethers.parseEther('1.0');
    const LOCK      = ethers.parseEther('0.4');

    beforeEach(async () => {
      await vault.connect(user).deposit({ value: DEPOSIT });
    });

    it('locks amount and emits BetLocked', async () => {
      await expect(vault.connect(user).lockForBet(MARKET_ID, LOCK))
        .to.emit(vault, 'BetLocked')
        .withArgs(user.address, MARKET_ID, LOCK);

      expect(await vault.lockedAmounts(user.address, MARKET_ID)).to.equal(LOCK);
      expect(await vault.totalLocked(user.address)).to.equal(LOCK);
    });

    it('getFreeBalance excludes locked amount', async () => {
      await vault.connect(user).lockForBet(MARKET_ID, LOCK);
      const free = await vault.getFreeBalance(user.address);
      expect(free).to.equal(DEPOSIT - LOCK);
    });

    it('getBalance still returns total balance including locked', async () => {
      await vault.connect(user).lockForBet(MARKET_ID, LOCK);
      expect(await vault.getBalance(user.address)).to.equal(DEPOSIT);
    });

    it('reverts on zero lock amount', async () => {
      await expect(
        vault.connect(user).lockForBet(MARKET_ID, 0)
      ).to.be.revertedWithCustomError(vault, 'ZeroAmount');
    });

    it('reverts if insufficient free balance', async () => {
      const tooMuch = ethers.parseEther('1.5');
      await expect(
        vault.connect(user).lockForBet(MARKET_ID, tooMuch)
      ).to.be.revertedWithCustomError(vault, 'InsufficientBalance');
    });

    it('reverts if market already has a lock', async () => {
      await vault.connect(user).lockForBet(MARKET_ID, LOCK);
      await expect(
        vault.connect(user).lockForBet(MARKET_ID, ethers.parseEther('0.1'))
      ).to.be.revertedWithCustomError(vault, 'BetAlreadyLocked');
    });

    it('allows locking separate amounts for different markets', async () => {
      const MARKET_ID_2 = ethers.keccak256(ethers.toUtf8Bytes('market-lock-002'));
      await vault.connect(user).lockForBet(MARKET_ID,   ethers.parseEther('0.3'));
      await vault.connect(user).lockForBet(MARKET_ID_2, ethers.parseEther('0.3'));

      expect(await vault.totalLocked(user.address)).to.equal(ethers.parseEther('0.6'));
      expect(await vault.getFreeBalance(user.address)).to.equal(ethers.parseEther('0.4'));
    });

    it('locked balance blocks withdrawal of locked funds', async () => {
      await vault.connect(user).lockForBet(MARKET_ID, LOCK);
      // Free = 0.6 FLOW, so withdrawing 0.7 FLOW should fail
      await expect(
        vault.connect(user).withdraw(ethers.parseEther('0.7'))
      ).to.be.revertedWithCustomError(vault, 'InsufficientBalance');
    });

    it('allows withdrawal of free balance while locked funds are held', async () => {
      await vault.connect(user).lockForBet(MARKET_ID, LOCK);
      // Free = 0.6 FLOW — withdrawal should succeed
      await expect(vault.connect(user).withdraw(ethers.parseEther('0.6'))).to.not.be.reverted;
    });

    it('pause blocks lockForBet', async () => {
      await vault.connect(owner).pause();
      await expect(
        vault.connect(user).lockForBet(MARKET_ID, LOCK)
      ).to.be.revertedWithCustomError(vault, 'EnforcedPause');
    });
  });

  // ─── Payout claim with collateral ────────────────────────────────────────

  describe('claimPayout with collateral lock', () => {
    const MARKET_ID = ethers.keccak256(ethers.toUtf8Bytes('market-payout-lock'));
    const DEPOSIT   = ethers.parseEther('1.0');
    const STAKE     = ethers.parseEther('0.2');

    async function signPayout(
      who: typeof user,
      marketId: string,
      amount: bigint,
      nonce: number,
      expiry: number
    ) {
      const vaultAddress = await vault.getAddress();
      const msgHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['address', 'bytes32', 'uint256', 'uint256', 'uint256', 'address'],
          [who.address, marketId, amount, nonce, expiry, vaultAddress]
        )
      );
      return settlementSigner.signMessage(ethers.getBytes(msgHash));
    }

    beforeEach(async () => {
      await vault.connect(user).deposit({ value: DEPOSIT });
      await vault.connect(user).lockForBet(MARKET_ID, STAKE);
    });

    it('winner: releases lock and credits net payout (stake + winnings)', async () => {
      const payout = ethers.parseEther('0.35'); // stake 0.2 + winnings 0.15
      const nonce  = 1;
      const expiry = (await ethers.provider.getBlock('latest'))!.timestamp + 3600;
      const sig    = await signPayout(user, MARKET_ID, payout, nonce, expiry);

      await expect(vault.connect(user).claimPayout(MARKET_ID, payout, nonce, expiry, sig))
        .to.emit(vault, 'BetUnlocked').withArgs(user.address, MARKET_ID, STAKE)
        .and.to.emit(vault, 'PayoutClaimed').withArgs(user.address, MARKET_ID, payout);

      // Final balance: 1.0 - 0.2 (stake deducted) + 0.35 (payout credited) = 1.15
      expect(await vault.getBalance(user.address)).to.equal(ethers.parseEther('1.15'));
      expect(await vault.totalLocked(user.address)).to.equal(0n);
      expect(await vault.lockedAmounts(user.address, MARKET_ID)).to.equal(0n);
    });

    it('loser: releases lock and deducts stake (payout = 0)', async () => {
      const payout = 0n;
      const nonce  = 1;
      const expiry = (await ethers.provider.getBlock('latest'))!.timestamp + 3600;
      const sig    = await signPayout(user, MARKET_ID, payout, nonce, expiry);

      await expect(vault.connect(user).claimPayout(MARKET_ID, payout, nonce, expiry, sig))
        .to.emit(vault, 'BetUnlocked').withArgs(user.address, MARKET_ID, STAKE)
        .and.to.emit(vault, 'PayoutClaimed').withArgs(user.address, MARKET_ID, payout);

      // Final balance: 1.0 - 0.2 (stake consumed) + 0 = 0.8
      expect(await vault.getBalance(user.address)).to.equal(ethers.parseEther('0.8'));
      expect(await vault.totalLocked(user.address)).to.equal(0n);
    });

    it('after settlement, lock is fully cleared and free balance is withdrawable', async () => {
      const payout = ethers.parseEther('0.35');
      const nonce  = 1;
      const expiry = (await ethers.provider.getBlock('latest'))!.timestamp + 3600;
      const sig    = await signPayout(user, MARKET_ID, payout, nonce, expiry);

      // Fund the vault with winnings from a second depositor (simulates other bettors' stakes)
      await vault.connect(relayer).deposit({ value: ethers.parseEther('0.5') });

      await vault.connect(user).claimPayout(MARKET_ID, payout, nonce, expiry, sig);

      // Lock is gone — totalLocked is 0, getFreeBalance == getBalance
      expect(await vault.totalLocked(user.address)).to.equal(0n);
      expect(await vault.getFreeBalance(user.address)).to.equal(await vault.getBalance(user.address));

      // 1.0 deposited - 0.2 stake + 0.35 payout = 1.15 withdrawable
      await expect(vault.connect(user).withdraw(ethers.parseEther('1.15'))).to.not.be.reverted;
    });
  });
});
