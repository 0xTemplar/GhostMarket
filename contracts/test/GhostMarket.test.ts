import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { GhostMarket } from '../typechain-types';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

const WEEK    = 7 * 24 * 60 * 60;
const FEE_BPS = 200n;

async function deployMarket(
  owner: HardhatEthersSigner,
  resolver: HardhatEthersSigner,
  treasury: HardhatEthersSigner,
): Promise<GhostMarket> {
  const Factory = await ethers.getContractFactory('GhostMarket', owner);
  const m = await Factory.deploy(resolver.address, treasury.address);
  await m.waitForDeployment();
  return m as unknown as GhostMarket;
}

describe('GhostMarket', () => {
  let market: GhostMarket;
  let owner: HardhatEthersSigner;
  let resolver: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let charlie: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;

  let expiryAt: number;

  beforeEach(async () => {
    [owner, resolver, alice, bob, charlie, treasury] = await ethers.getSigners();
    expiryAt = (await time.latest()) + WEEK;
    market   = await deployMarket(owner, resolver, treasury);
  });

  // ─── Constructor ────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('sets owner, resolver, treasury', async () => {
      expect(await market.owner()).to.equal(owner.address);
      expect(await market.resolver()).to.equal(resolver.address);
      expect(await market.treasury()).to.equal(treasury.address);
    });

    it('reverts on zero resolver', async () => {
      const F = await ethers.getContractFactory('GhostMarket', owner);
      await expect(
        F.deploy(ethers.ZeroAddress, treasury.address)
      ).to.be.revertedWithCustomError(market, 'InvalidResolver');
    });
  });

  // ─── createMarket ───────────────────────────────────────────────────────────

  describe('createMarket', () => {
    it('increments marketCount and stores data', async () => {
      await market.createMarket('ETH 10k?', 'desc', 'Crypto', 'chainlink', expiryAt);
      expect(await market.marketCount()).to.equal(1n);
      const m = await market.markets(1);
      expect(m.title).to.equal('ETH 10k?');
      expect(m.expiryAt).to.equal(BigInt(expiryAt));
      expect(m.status).to.equal(0n); // Active
    });

    it('reverts for non-owner', async () => {
      await expect(
        market.connect(alice).createMarket('Q', 'desc', 'Crypto', 'src', expiryAt)
      ).to.be.revertedWithCustomError(market, 'OwnableUnauthorizedAccount');
    });

    it('reverts when expiry is in the past', async () => {
      await expect(
        market.createMarket('Q', 'desc', 'Crypto', 'src', (await time.latest()) - 1)
      ).to.be.revertedWithCustomError(market, 'InvalidExpiry');
    });

    it('reverts when expiry is beyond MAX_MARKET_DURATION', async () => {
      const tooFar = (await time.latest()) + 731 * 24 * 3600;
      await expect(
        market.createMarket('Q', 'desc', 'Crypto', 'src', tooFar)
      ).to.be.revertedWithCustomError(market, 'InvalidExpiry');
    });

    it('reverts when paused', async () => {
      await market.pause();
      await expect(
        market.createMarket('Q', 'desc', 'Crypto', 'src', expiryAt)
      ).to.be.revertedWithCustomError(market, 'EnforcedPause');
    });

    it('reverts on empty string', async () => {
      await expect(
        market.createMarket('', 'desc', 'Crypto', 'src', expiryAt)
      ).to.be.revertedWithCustomError(market, 'InvalidStringLength');
    });
  });

  // ─── placeBet ───────────────────────────────────────────────────────────────

  describe('placeBet', () => {
    beforeEach(async () => {
      await market.createMarket('Q', 'desc', 'Crypto', 'src', expiryAt);
    });

    it('records YES bet and updates pool', async () => {
      await market.connect(alice).placeBet(1, true, { value: ethers.parseEther('1') });
      const m = await market.markets(1);
      expect(m.yesPool).to.equal(ethers.parseEther('1'));
      expect(m.noPool).to.equal(0n);
    });

    it('records NO bet and updates pool', async () => {
      await market.connect(bob).placeBet(1, false, { value: ethers.parseEther('2') });
      const m = await market.markets(1);
      expect(m.noPool).to.equal(ethers.parseEther('2'));
    });

    it('accumulates multiple bets from same user', async () => {
      await market.connect(alice).placeBet(1, true, { value: ethers.parseEther('1') });
      await market.connect(alice).placeBet(1, true, { value: ethers.parseEther('0.5') });
      const pos = await market.getUserPosition(1, alice.address);
      expect(pos.yes).to.equal(ethers.parseEther('1.5'));
    });

    it('reverts below minBet', async () => {
      await expect(
        market.connect(alice).placeBet(1, true, { value: 1n })
      ).to.be.revertedWithCustomError(market, 'BetBelowMinimum');
    });

    it('reverts after expiry', async () => {
      await time.increaseTo(expiryAt);
      await expect(
        market.connect(alice).placeBet(1, true, { value: ethers.parseEther('1') })
      ).to.be.revertedWithCustomError(market, 'MarketAlreadyExpired');
    });

    it('reverts when paused', async () => {
      await market.pause();
      await expect(
        market.connect(alice).placeBet(1, true, { value: ethers.parseEther('1') })
      ).to.be.revertedWithCustomError(market, 'EnforcedPause');
    });
  });

  // ─── yesPrice / noPrice ─────────────────────────────────────────────────────

  describe('price helpers', () => {
    beforeEach(async () => {
      await market.createMarket('Q', 'desc', 'Crypto', 'src', expiryAt);
    });

    it('returns 5000 when pools are empty', async () => {
      expect(await market.yesPrice(1)).to.equal(5000n);
      expect(await market.noPrice(1)).to.equal(5000n);
    });

    it('returns 7500/2500 for 3:1 YES/NO pool split', async () => {
      await market.connect(alice).placeBet(1, true,  { value: ethers.parseEther('3') });
      await market.connect(bob  ).placeBet(1, false, { value: ethers.parseEther('1') });
      expect(await market.yesPrice(1)).to.equal(7500n);
      expect(await market.noPrice(1)).to.equal(2500n);
    });
  });

  // ─── resolveMarket ──────────────────────────────────────────────────────────

  describe('resolveMarket', () => {
    beforeEach(async () => {
      await market.createMarket('Q', 'desc', 'Crypto', 'src', expiryAt);
    });

    it('resolver resolves YES after expiry', async () => {
      await time.increaseTo(expiryAt + 1);
      await market.connect(resolver).resolveMarket(1, true);
      const m = await market.markets(1);
      expect(m.status).to.equal(1n); // Resolved
      expect(m.outcome).to.equal(true);
    });

    it('owner can also resolve (break-glass)', async () => {
      await time.increaseTo(expiryAt + 1);
      await market.connect(owner).resolveMarket(1, false);
      expect((await market.markets(1)).outcome).to.equal(false);
    });

    it('reverts before expiry', async () => {
      await expect(
        market.connect(resolver).resolveMarket(1, true)
      ).to.be.revertedWithCustomError(market, 'MarketNotExpiredYet');
    });

    it('reverts for unauthorised caller', async () => {
      await time.increaseTo(expiryAt + 1);
      await expect(
        market.connect(alice).resolveMarket(1, true)
      ).to.be.revertedWithCustomError(market, 'OwnableUnauthorizedAccount');
    });
  });

  // ─── claimWinnings ──────────────────────────────────────────────────────────

  describe('claimWinnings', () => {
    beforeEach(async () => {
      await market.createMarket('Q', 'desc', 'Crypto', 'src', expiryAt);
      // Alice: 3 FLOW on YES, Bob: 1 FLOW on NO
      await market.connect(alice).placeBet(1, true,  { value: ethers.parseEther('3') });
      await market.connect(bob  ).placeBet(1, false, { value: ethers.parseEther('1') });
      await time.increaseTo(expiryAt + 1);
    });

    it('pays correct net amount to YES winner', async () => {
      await market.connect(resolver).resolveMarket(1, true);

      const before = await ethers.provider.getBalance(alice.address);
      const tx     = await market.connect(alice).claimWinnings(1);
      const rcpt   = await tx.wait();
      const gas    = rcpt!.gasUsed * rcpt!.gasPrice;
      const after  = await ethers.provider.getBalance(alice.address);

      // gross = 4 FLOW (full pool); fee = 2% = 0.08; net = 3.92
      const expectedNet = ethers.parseEther('4') * (10_000n - FEE_BPS) / 10_000n;
      expect(after - before + gas).to.be.closeTo(expectedNet, ethers.parseEther('0.001'));
    });

    it('sends protocol fee to treasury', async () => {
      await market.connect(resolver).resolveMarket(1, true);
      const before = await ethers.provider.getBalance(treasury.address);
      await market.connect(alice).claimWinnings(1);
      const after  = await ethers.provider.getBalance(treasury.address);
      const fee    = ethers.parseEther('4') * FEE_BPS / 10_000n;
      expect(after - before).to.equal(fee);
    });

    it('waives fee when treasury is address(0)', async () => {
      // Deploy fresh market with no treasury
      const m2 = await deployMarket(owner, resolver, owner); // use owner as placeholder
      await m2.setTreasury(ethers.ZeroAddress);
      await m2.createMarket('Q', 'desc', 'Crypto', 'src', expiryAt + 100);
      await m2.connect(alice).placeBet(1, true,  { value: ethers.parseEther('3') });
      await m2.connect(bob  ).placeBet(1, false, { value: ethers.parseEther('1') });
      await time.increaseTo(expiryAt + 101);
      await m2.connect(resolver).resolveMarket(1, true);

      const before = await ethers.provider.getBalance(alice.address);
      const tx     = await m2.connect(alice).claimWinnings(1);
      const rcpt   = await tx.wait();
      const gas    = rcpt!.gasUsed * rcpt!.gasPrice;
      const after  = await ethers.provider.getBalance(alice.address);

      // No fee, full 4 FLOW
      expect(after - before + gas).to.be.closeTo(ethers.parseEther('4'), ethers.parseEther('0.001'));
    });

    it('reverts for losing side', async () => {
      await market.connect(resolver).resolveMarket(1, false); // NO wins
      await expect(
        market.connect(alice).claimWinnings(1) // Alice bet YES
      ).to.be.revertedWithCustomError(market, 'NoWinningPosition');
    });

    it('reverts on double claim', async () => {
      await market.connect(resolver).resolveMarket(1, true);
      await market.connect(alice).claimWinnings(1);
      await expect(
        market.connect(alice).claimWinnings(1)
      ).to.be.revertedWithCustomError(market, 'AlreadyClaimed');
    });

    it('reverts before resolution', async () => {
      await expect(
        market.connect(alice).claimWinnings(1)
      ).to.be.revertedWithCustomError(market, 'MarketNotResolved');
    });
  });

  // ─── claimRefund (grace period) ─────────────────────────────────────────────

  describe('claimRefund — grace period', () => {
    beforeEach(async () => {
      await market.createMarket('Q', 'desc', 'Crypto', 'src', expiryAt);
      await market.connect(alice).placeBet(1, true,  { value: ethers.parseEther('2') });
      await market.connect(bob  ).placeBet(1, false, { value: ethers.parseEther('1') });
    });

    it('allows refund after grace period when unresolved', async () => {
      const GRACE = 7 * 24 * 3600;
      await time.increaseTo(expiryAt + GRACE + 1);

      expect(await market.isRefundEligible(1)).to.equal(true);

      const before = await ethers.provider.getBalance(alice.address);
      const tx     = await market.connect(alice).claimRefund(1);
      const rcpt   = await tx.wait();
      const gas    = rcpt!.gasUsed * rcpt!.gasPrice;
      const after  = await ethers.provider.getBalance(alice.address);

      // Full refund (2 FLOW staked)
      expect(after - before + gas).to.be.closeTo(ethers.parseEther('2'), ethers.parseEther('0.001'));
    });

    it('reverts before grace period ends', async () => {
      await time.increaseTo(expiryAt + 1); // past expiry but within grace
      await expect(
        market.connect(alice).claimRefund(1)
      ).to.be.revertedWithCustomError(market, 'MarketNotEligibleForRefund');
    });

    it('reverts if market was resolved (use claimWinnings instead)', async () => {
      await time.increaseTo(expiryAt + 1);
      await market.connect(resolver).resolveMarket(1, true);
      await expect(
        market.connect(alice).claimRefund(1)
      ).to.be.revertedWithCustomError(market, 'MarketNotEligibleForRefund');
    });
  });

  // ─── claimRefund (cancelled) ────────────────────────────────────────────────

  describe('claimRefund — cancelled market', () => {
    beforeEach(async () => {
      await market.createMarket('Q', 'desc', 'Crypto', 'src', expiryAt);
      await market.connect(alice).placeBet(1, true, { value: ethers.parseEther('1') });
    });

    it('refunds full stake after cancellation', async () => {
      await market.cancelMarket(1);
      expect(await market.isRefundEligible(1)).to.equal(true);

      const before = await ethers.provider.getBalance(alice.address);
      const tx     = await market.connect(alice).claimRefund(1);
      const rcpt   = await tx.wait();
      const gas    = rcpt!.gasUsed * rcpt!.gasPrice;
      const after  = await ethers.provider.getBalance(alice.address);
      expect(after - before + gas).to.be.closeTo(ethers.parseEther('1'), ethers.parseEther('0.001'));
    });

    it('reverts double refund', async () => {
      await market.cancelMarket(1);
      await market.connect(alice).claimRefund(1);
      await expect(
        market.connect(alice).claimRefund(1)
      ).to.be.revertedWithCustomError(market, 'AlreadyClaimed');
    });

    it('reverts for user with no position', async () => {
      await market.cancelMarket(1);
      await expect(
        market.connect(charlie).claimRefund(1)
      ).to.be.revertedWithCustomError(market, 'NoPositionToRefund');
    });
  });

  // ─── dispute / re-resolve ───────────────────────────────────────────────────

  describe('dispute flow', () => {
    it('owner can dispute then re-resolve', async () => {
      await market.createMarket('Q', 'desc', 'Crypto', 'src', expiryAt);
      await market.connect(alice).placeBet(1, true, { value: ethers.parseEther('1') });
      await time.increaseTo(expiryAt + 1);
      await market.connect(resolver).resolveMarket(1, true);

      await market.disputeMarket(1);
      expect((await market.markets(1)).status).to.equal(2n); // Disputed

      await market.reResolveMarket(1, false);
      const m = await market.markets(1);
      expect(m.status).to.equal(1n);  // Resolved
      expect(m.outcome).to.equal(false);
    });
  });

  // ─── Ownable2Step ───────────────────────────────────────────────────────────

  describe('Ownable2Step', () => {
    it('requires new owner to accept before transfer completes', async () => {
      await market.transferOwnership(alice.address);
      // pending transfer — owner is still old owner
      expect(await market.owner()).to.equal(owner.address);
      // alice must accept
      await market.connect(alice).acceptOwnership();
      expect(await market.owner()).to.equal(alice.address);
    });
  });

  // ─── Admin guards ───────────────────────────────────────────────────────────

  describe('admin', () => {
    it('setFeeBps: 5% succeeds, 5.01% reverts', async () => {
      await market.setFeeBps(500);
      expect(await market.feeBps()).to.equal(500n);
      await expect(market.setFeeBps(501)).to.be.revertedWithCustomError(market, 'FeeTooHigh');
    });

    it('setResolver reverts on zero address', async () => {
      await expect(
        market.setResolver(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(market, 'InvalidResolver');
    });

    it('pause / unpause toggle', async () => {
      await market.pause();
      expect(await market.paused()).to.equal(true);
      await market.unpause();
      expect(await market.paused()).to.equal(false);
    });
  });

  // ─── getAllMarketIds ─────────────────────────────────────────────────────────

  describe('getAllMarketIds', () => {
    it('returns empty when no markets', async () => {
      expect((await market.getAllMarketIds()).length).to.equal(0);
    });

    it('returns [1,2,3] after three markets', async () => {
      for (let i = 0; i < 3; i++) {
        await market.createMarket(`Q${i}`, 'desc', 'Crypto', 'src', expiryAt + i);
      }
      const ids = await market.getAllMarketIds();
      expect(ids.map(Number)).to.deep.equal([1, 2, 3]);
    });
  });
});
