/**
 * GhostEAMM.test.ts
 *
 * Tests for the encrypted AMM (Phase 4).
 *
 * Run modes:
 *   npx hardhat test --network hardhat          # mock FHE, fast (CI)
 *   npx hardhat test --network localhost        # mock FHE, persistent node
 *   npx hardhat test --network sepolia          # real FHE, slow
 *
 * The @fhevm/hardhat-plugin makes `fhevm` available on the Hardhat runtime.
 * In hardhat/localhost mode it uses mock encryption so tests run instantly.
 * In sepolia mode it uses real Zama FHE — expect minutes per test.
 *
 * Docs: https://docs.zama.org/protocol/solidity-guides/development-guide/hardhat
 */

import { GhostEAMM, GhostEAMM__factory } from '../typechain-types';
import { FhevmType } from '@fhevm/hardhat-plugin';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { expect } from 'chai';
import { ethers, fhevm } from 'hardhat';

// ─── Types ────────────────────────────────────────────────────────────────────

type Signers = {
  owner:    HardhatEthersSigner; // deployer + owner
  manager:  HardhatEthersSigner; // marketManager
  resolver: HardhatEthersSigner; // resolver
  alice:    HardhatEthersSigner; // bettor YES
  bob:      HardhatEthersSigner; // bettor NO
  lit:      HardhatEthersSigner; // simulates the Lit PKP decryptor (Phase 6)
};

// ─── Fixture ──────────────────────────────────────────────────────────────────

async function deployFixture() {
  const signers = await ethers.getSigners();
  const actors: Signers = {
    owner:    signers[0],
    manager:  signers[1],
    resolver: signers[2],
    alice:    signers[3],
    bob:      signers[4],
    lit:      signers[5],
  };

  const factory = (await ethers.getContractFactory('GhostEAMM')) as GhostEAMM__factory;
  const eamm    = (await factory.deploy(
    actors.manager.address,
    actors.resolver.address,
  )) as GhostEAMM;

  const eammAddress = await eamm.getAddress();

  return { eamm, eammAddress, ...actors };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MARKET_ID  = 1n;
const ONE_ETH    = ethers.parseEther('1');   // 1 FLOW / ETH in wei
const HALF_ETH   = ethers.parseEther('0.5');
const EXPIRY_1H  = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now
const EXPIRY_OLD = BigInt(Math.floor(Date.now() / 1000) - 1);    // already expired

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GhostEAMM', function () {
  let eamm:        GhostEAMM;
  let eammAddress: string;
  let owner:       HardhatEthersSigner;
  let manager:     HardhatEthersSigner;
  let resolver:    HardhatEthersSigner;
  let alice:       HardhatEthersSigner;
  let bob:         HardhatEthersSigner;
  let lit:         HardhatEthersSigner;

  beforeEach(async () => {
    ({ eamm, eammAddress, owner, manager, resolver, alice, bob, lit } =
      await deployFixture());
  });

  // ── Deployment ────────────────────────────────────────────────────────────

  describe('deployment', () => {
    it('sets owner, marketManager, and resolver correctly', async () => {
      expect(await eamm.owner()).to.equal(owner.address);
      expect(await eamm.marketManager()).to.equal(manager.address);
      expect(await eamm.resolver()).to.equal(resolver.address);
    });
  });

  // ── Market creation ───────────────────────────────────────────────────────

  describe('createMarket', () => {
    it('manager can create a market', async () => {
      await expect(
        eamm.connect(manager).createMarket(MARKET_ID, EXPIRY_1H),
      ).to.emit(eamm, 'MarketCreated').withArgs(MARKET_ID, EXPIRY_1H);

      const [status, , expiry] = await eamm.getMarketMeta(MARKET_ID);
      expect(status).to.equal(0); // Active
      expect(expiry).to.equal(EXPIRY_1H);
    });

    it('owner can create a market', async () => {
      await expect(
        eamm.connect(owner).createMarket(MARKET_ID, EXPIRY_1H),
      ).to.emit(eamm, 'MarketCreated');
    });

    it('non-manager cannot create a market', async () => {
      await expect(
        eamm.connect(alice).createMarket(MARKET_ID, EXPIRY_1H),
      ).to.be.revertedWithCustomError(eamm, 'Unauthorized');
    });

    it('cannot create the same market twice', async () => {
      await eamm.connect(manager).createMarket(MARKET_ID, EXPIRY_1H);
      await expect(
        eamm.connect(manager).createMarket(MARKET_ID, EXPIRY_1H),
      ).to.be.revertedWithCustomError(eamm, 'MarketAlreadyExists');
    });

    it('pool handles are initialised (non-zero after creation)', async () => {
      await eamm.connect(manager).createMarket(MARKET_ID, EXPIRY_1H);
      const [yesPool, noPool] = await eamm.getPoolHandles(MARKET_ID);
      // Trivially-encrypted zero is a non-zero handle (it is still a ciphertext).
      expect(yesPool).to.not.equal(ethers.ZeroHash);
      expect(noPool).to.not.equal(ethers.ZeroHash);
    });
  });

  // ── Encrypted bet placement ───────────────────────────────────────────────

  describe('placeBet', () => {
    beforeEach(async () => {
      await eamm.connect(manager).createMarket(MARKET_ID, EXPIRY_1H);
    });

    it('Alice can place an encrypted YES bet', async () => {
      const encInput = await fhevm
        .createEncryptedInput(eammAddress, alice.address)
        .add64(ONE_ETH)
        .encrypt();

      await expect(
        eamm.connect(alice).placeBet(
          MARKET_ID,
          true, // YES
          encInput.handles[0],
          encInput.inputProof,
        ),
      ).to.emit(eamm, 'BetPlaced').withArgs(MARKET_ID, alice.address, true);
    });

    it('Bob can place an encrypted NO bet', async () => {
      const encInput = await fhevm
        .createEncryptedInput(eammAddress, bob.address)
        .add64(HALF_ETH)
        .encrypt();

      await expect(
        eamm.connect(bob).placeBet(
          MARKET_ID,
          false, // NO
          encInput.handles[0],
          encInput.inputProof,
        ),
      ).to.emit(eamm, 'BetPlaced').withArgs(MARKET_ID, bob.address, false);
    });

    it('BetPlaced event contains no amount — only marketId, user, side', async () => {
      const encInput = await fhevm
        .createEncryptedInput(eammAddress, alice.address)
        .add64(ONE_ETH)
        .encrypt();

      const tx = await eamm.connect(alice).placeBet(
        MARKET_ID, true, encInput.handles[0], encInput.inputProof,
      );
      const receipt = await tx.wait();

      // Parse only GhostEAMM logs.
      const eammLogs = receipt!.logs
        .map((l) => { try { return eamm.interface.parseLog(l); } catch { return null; } })
        .filter(Boolean);

      // Exactly one GhostEAMM event: BetPlaced.
      expect(eammLogs).to.have.length(1);
      const betPlaced = eammLogs[0]!;
      expect(betPlaced.name).to.equal('BetPlaced');

      // The event has exactly 3 args (marketId, user, side) — no amount field.
      expect(betPlaced.args.length).to.equal(3);
      expect(betPlaced.args[0]).to.equal(MARKET_ID);         // marketId
      expect(betPlaced.args[1]).to.equal(alice.address);     // user
      expect(betPlaced.args[2]).to.equal(true);              // side (YES)
    });

    it('position handles are set after bet', async () => {
      const encInput = await fhevm
        .createEncryptedInput(eammAddress, alice.address)
        .add64(ONE_ETH)
        .encrypt();

      await eamm.connect(alice).placeBet(
        MARKET_ID, true, encInput.handles[0], encInput.inputProof,
      );

      const [yesHandle] = await eamm.getUserPositionHandles(MARKET_ID, alice.address);
      expect(yesHandle).to.not.equal(ethers.ZeroHash);
    });

    it('Alice can decrypt her own YES position (mock mode)', async () => {
      const betAmount = ONE_ETH;
      const encInput  = await fhevm
        .createEncryptedInput(eammAddress, alice.address)
        .add64(betAmount)
        .encrypt();

      await eamm.connect(alice).placeBet(
        MARKET_ID, true, encInput.handles[0], encInput.inputProof,
      );

      const [yesHandle] = await eamm.getUserPositionHandles(MARKET_ID, alice.address);

      const decryptedAmount = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        yesHandle,
        eammAddress,
        alice,
      );
      expect(decryptedAmount).to.equal(betAmount);
    });

    it('Bob cannot decrypt Alice\'s position', async () => {
      const encInput = await fhevm
        .createEncryptedInput(eammAddress, alice.address)
        .add64(ONE_ETH)
        .encrypt();

      await eamm.connect(alice).placeBet(
        MARKET_ID, true, encInput.handles[0], encInput.inputProof,
      );

      const [yesHandle] = await eamm.getUserPositionHandles(MARKET_ID, alice.address);

      // Bob is not ACL-permitted on Alice's handle — decryption should fail.
      await expect(
        fhevm.userDecryptEuint(FhevmType.euint64, yesHandle, eammAddress, bob),
      ).to.be.rejected;
    });

    it('multiple bets accumulate in encrypted pool', async () => {
      const bet1 = ethers.parseEther('1');
      const bet2 = ethers.parseEther('2');

      for (const [signer, amount] of [[alice, bet1], [bob, bet2]] as const) {
        const enc = await fhevm
          .createEncryptedInput(eammAddress, signer.address)
          .add64(amount)
          .encrypt();
        await eamm.connect(signer).placeBet(MARKET_ID, true, enc.handles[0], enc.inputProof);
      }

      // Both YES positions should be independently decryptable.
      const [aliceYes] = await eamm.getUserPositionHandles(MARKET_ID, alice.address);
      const [bobYes]   = await eamm.getUserPositionHandles(MARKET_ID, bob.address);

      expect(await fhevm.userDecryptEuint(FhevmType.euint64, aliceYes, eammAddress, alice))
        .to.equal(bet1);
      expect(await fhevm.userDecryptEuint(FhevmType.euint64, bobYes, eammAddress, bob))
        .to.equal(bet2);
    });

    it('rejects bet on an expired market', async () => {
      await eamm.connect(manager).createMarket(2n, EXPIRY_OLD);
      const encInput = await fhevm
        .createEncryptedInput(eammAddress, alice.address)
        .add64(ONE_ETH)
        .encrypt();

      await expect(
        eamm.connect(alice).placeBet(2n, true, encInput.handles[0], encInput.inputProof),
      ).to.be.revertedWithCustomError(eamm, 'MarketExpired');
    });

    it('rejects bet on a non-existent market', async () => {
      const encInput = await fhevm
        .createEncryptedInput(eammAddress, alice.address)
        .add64(ONE_ETH)
        .encrypt();

      await expect(
        eamm.connect(alice).placeBet(999n, true, encInput.handles[0], encInput.inputProof),
      ).to.be.revertedWithCustomError(eamm, 'MarketNotFound');
    });
  });

  // ── Resolution ────────────────────────────────────────────────────────────

  describe('resolveMarket', () => {
    beforeEach(async () => {
      await eamm.connect(manager).createMarket(MARKET_ID, EXPIRY_1H);
    });

    it('resolver can resolve YES', async () => {
      await expect(
        eamm.connect(resolver).resolveMarket(MARKET_ID, true),
      ).to.emit(eamm, 'MarketResolved').withArgs(MARKET_ID, true);

      const [status, outcome] = await eamm.getMarketMeta(MARKET_ID);
      expect(status).to.equal(1);   // Resolved
      expect(outcome).to.equal(true);
    });

    it('resolver can resolve NO', async () => {
      await eamm.connect(resolver).resolveMarket(MARKET_ID, false);
      const [, outcome] = await eamm.getMarketMeta(MARKET_ID);
      expect(outcome).to.equal(false);
    });

    it('owner can also resolve', async () => {
      await expect(
        eamm.connect(owner).resolveMarket(MARKET_ID, true),
      ).to.emit(eamm, 'MarketResolved');
    });

    it('non-resolver cannot resolve', async () => {
      await expect(
        eamm.connect(alice).resolveMarket(MARKET_ID, true),
      ).to.be.revertedWithCustomError(eamm, 'Unauthorized');
    });

    it('cannot resolve already-resolved market', async () => {
      await eamm.connect(resolver).resolveMarket(MARKET_ID, true);
      await expect(
        eamm.connect(resolver).resolveMarket(MARKET_ID, false),
      ).to.be.revertedWithCustomError(eamm, 'MarketNotActive');
    });

    it('cannot place bet after resolution', async () => {
      await eamm.connect(resolver).resolveMarket(MARKET_ID, true);
      const encInput = await fhevm
        .createEncryptedInput(eammAddress, alice.address)
        .add64(ONE_ETH)
        .encrypt();

      await expect(
        eamm.connect(alice).placeBet(MARKET_ID, true, encInput.handles[0], encInput.inputProof),
      ).to.be.revertedWithCustomError(eamm, 'MarketNotActive');
    });
  });

  // ── Cancellation ──────────────────────────────────────────────────────────

  describe('cancelMarket', () => {
    beforeEach(async () => {
      await eamm.connect(manager).createMarket(MARKET_ID, EXPIRY_1H);
    });

    it('resolver can cancel', async () => {
      await expect(
        eamm.connect(resolver).cancelMarket(MARKET_ID),
      ).to.emit(eamm, 'MarketCancelled').withArgs(MARKET_ID);
    });

    it('non-resolver cannot cancel', async () => {
      await expect(
        eamm.connect(bob).cancelMarket(MARKET_ID),
      ).to.be.revertedWithCustomError(eamm, 'Unauthorized');
    });
  });

  // ── grantPositionAccess (Phase 6 hook) ────────────────────────────────────

  describe('grantPositionAccess', () => {
    beforeEach(async () => {
      await eamm.connect(manager).createMarket(MARKET_ID, EXPIRY_1H);

      // Alice bets YES, Bob bets NO.
      const aliceEnc = await fhevm
        .createEncryptedInput(eammAddress, alice.address)
        .add64(ONE_ETH)
        .encrypt();
      await eamm.connect(alice).placeBet(MARKET_ID, true, aliceEnc.handles[0], aliceEnc.inputProof);

      const bobEnc = await fhevm
        .createEncryptedInput(eammAddress, bob.address)
        .add64(HALF_ETH)
        .encrypt();
      await eamm.connect(bob).placeBet(MARKET_ID, false, bobEnc.handles[0], bobEnc.inputProof);
    });

    it('grants Lit PKP access to the winner\'s position after YES resolution', async () => {
      await eamm.connect(resolver).resolveMarket(MARKET_ID, true); // YES wins

      await expect(
        eamm.connect(resolver).grantPositionAccess(MARKET_ID, alice.address, lit.address),
      ).to.emit(eamm, 'PositionAccessGranted').withArgs(MARKET_ID, alice.address, lit.address);

      // Lit PKP (simulated as `lit` signer) can now decrypt Alice's YES position.
      const [yesHandle] = await eamm.getUserPositionHandles(MARKET_ID, alice.address);
      const decrypted   = await fhevm.userDecryptEuint(
        FhevmType.euint64, yesHandle, eammAddress, lit,
      );
      expect(decrypted).to.equal(ONE_ETH);
    });

    it('reverts for a user with no position', async () => {
      await eamm.connect(resolver).resolveMarket(MARKET_ID, true);
      // `lit` address has no position.
      await expect(
        eamm.connect(resolver).grantPositionAccess(MARKET_ID, lit.address, lit.address),
      ).to.be.revertedWithCustomError(eamm, 'NoPositionExists');
    });

    it('reverts if market is still active', async () => {
      await expect(
        eamm.connect(resolver).grantPositionAccess(MARKET_ID, alice.address, lit.address),
      ).to.be.revertedWithCustomError(eamm, 'MarketNotActive');
    });

    it('grants both positions after cancellation for refunds', async () => {
      await eamm.connect(resolver).cancelMarket(MARKET_ID);

      // Alice gets both positions accessible (for refund — she only has YES).
      await expect(
        eamm.connect(resolver).grantPositionAccess(MARKET_ID, alice.address, lit.address),
      ).to.emit(eamm, 'PositionAccessGranted');

      const [yesHandle] = await eamm.getUserPositionHandles(MARKET_ID, alice.address);
      const decrypted   = await fhevm.userDecryptEuint(
        FhevmType.euint64, yesHandle, eammAddress, lit,
      );
      expect(decrypted).to.equal(ONE_ETH);
    });
  });

  // ── hasPosition ───────────────────────────────────────────────────────────

  describe('hasPosition', () => {
    beforeEach(async () => {
      await eamm.connect(manager).createMarket(MARKET_ID, EXPIRY_1H);
    });

    it('returns false before any bet', async () => {
      expect(await eamm.hasPosition(MARKET_ID, alice.address)).to.be.false;
    });

    it('returns true after a YES bet', async () => {
      const enc = await fhevm
        .createEncryptedInput(eammAddress, alice.address)
        .add64(ONE_ETH)
        .encrypt();
      await eamm.connect(alice).placeBet(MARKET_ID, true, enc.handles[0], enc.inputProof);
      expect(await eamm.hasPosition(MARKET_ID, alice.address)).to.be.true;
    });
  });

  // ── Minimum bet guard (FHE.gt + FHE.select) ──────────────────────────────

  describe('minimum bet guard', () => {
    beforeEach(async () => {
      await eamm.connect(manager).createMarket(MARKET_ID, EXPIRY_1H);
    });

    it('MIN_BET_WEI constant is exposed and non-zero', async () => {
      const min = await eamm.MIN_BET_WEI();
      expect(min).to.be.gt(0n);
    });

    it('bet above minimum records a non-zero position handle', async () => {
      // ONE_ETH (1e18) >> MIN_BET_WEI (1e9) — FHE.select picks the real amount
      const encInput = await fhevm
        .createEncryptedInput(eammAddress, alice.address)
        .add64(ONE_ETH)
        .encrypt();

      await eamm.connect(alice).placeBet(
        MARKET_ID, true, encInput.handles[0], encInput.inputProof,
      );

      // Position handle should be initialized (non-zero bytes32)
      const [yesHandle] = await eamm.getUserPositionHandles(MARKET_ID, alice.address);
      expect(yesHandle).to.not.equal(ethers.ZeroHash);

      // Decrypt to confirm the stored value equals the original amount
      const decrypted = await fhevm.userDecryptEuint(
        FhevmType.euint64, yesHandle, eammAddress, alice,
      );
      expect(decrypted).to.equal(ONE_ETH);
    });

    it('bet below minimum is silently zeroed — no dust position recorded', async () => {
      // 500 wei < MIN_BET_WEI (1e9) — FHE.select returns encrypt(0)
      const dustAmount = 500n;
      const encInput = await fhevm
        .createEncryptedInput(eammAddress, alice.address)
        .add64(dustAmount)
        .encrypt();

      // Transaction succeeds (no revert) but position receives 0
      await eamm.connect(alice).placeBet(
        MARKET_ID, true, encInput.handles[0], encInput.inputProof,
      );

      // The position accumulator was incremented by 0, so decrypted value = 0
      const [yesHandle] = await eamm.getUserPositionHandles(MARKET_ID, alice.address);
      const decrypted = await fhevm.userDecryptEuint(
        FhevmType.euint64, yesHandle, eammAddress, alice,
      );
      expect(decrypted).to.equal(0n);

      // Note: FHE.isInitialized returns true once the slot is written, even if
      // the value is 0. This is expected behaviour — the guard zeroes the value,
      // it does not prevent the slot write.
    });
  });

  // ── Sealed-bid windows ────────────────────────────────────────────────────

  describe('sealed-bid windows', () => {
    const WINDOW_SECS = 60n; // 60 s window for tests

    beforeEach(async () => {
      await eamm.connect(manager).createMarket(MARKET_ID, EXPIRY_1H);
    });

    // ── openSealedWindow ────────────────────────────────────────────────────

    it('manager can open a sealed window', async () => {
      await expect(
        eamm.connect(manager).openSealedWindow(MARKET_ID, WINDOW_SECS),
      ).to.emit(eamm, 'SealedWindowOpened').withArgs(
        MARKET_ID,
        0n,        // first window idx
        anyValue,  // startsAt (dynamic — block.timestamp)
        anyValue,  // endsAt   (dynamic — block.timestamp + durationSecs)
      );

      expect(await eamm.getSealedWindowCount(MARKET_ID)).to.equal(1n);
    });

    it('owner can open a sealed window', async () => {
      await expect(
        eamm.connect(owner).openSealedWindow(MARKET_ID, WINDOW_SECS),
      ).to.emit(eamm, 'SealedWindowOpened');
    });

    it('non-manager cannot open a sealed window', async () => {
      await expect(
        eamm.connect(alice).openSealedWindow(MARKET_ID, WINDOW_SECS),
      ).to.be.revertedWithCustomError(eamm, 'Unauthorized');
    });

    it('reverts if duration is below MIN_WINDOW_SECS', async () => {
      await expect(
        eamm.connect(manager).openSealedWindow(MARKET_ID, 10n),
      ).to.be.revertedWithCustomError(eamm, 'DurationTooShort');
    });

    it('cannot open a second window while first is still pending settlement', async () => {
      await eamm.connect(manager).openSealedWindow(MARKET_ID, WINDOW_SECS);
      await expect(
        eamm.connect(manager).openSealedWindow(MARKET_ID, WINDOW_SECS),
      ).to.be.revertedWithCustomError(eamm, 'WindowStillPending');
    });

    it('snapshots pool handles at open time (non-zero for initialised pools)', async () => {
      await eamm.connect(manager).openSealedWindow(MARKET_ID, WINDOW_SECS);
      const [, , , yesSnap, noSnap] = await eamm.getSealedWindow(MARKET_ID, 0n);
      // Pools were initialised to FHE.asEuint64(0) — handles are non-zero ciphertexts.
      expect(yesSnap).to.not.equal(ethers.ZeroHash);
      expect(noSnap).to.not.equal(ethers.ZeroHash);
    });

    // ── Bets during window ──────────────────────────────────────────────────

    it('bets are accepted during an open window', async () => {
      await eamm.connect(manager).openSealedWindow(MARKET_ID, WINDOW_SECS);

      const enc = await fhevm
        .createEncryptedInput(eammAddress, alice.address)
        .add64(ONE_ETH)
        .encrypt();

      // Should succeed — window is open, not yet expired.
      await expect(
        eamm.connect(alice).placeBet(MARKET_ID, true, enc.handles[0], enc.inputProof),
      ).to.emit(eamm, 'BetPlaced');
    });

    // ── Settlement pending guard ────────────────────────────────────────────

    it('blocks bets when window has expired but not yet settled', async () => {
      // Open a very short window (minimum 30 s) then warp past it.
      const MIN_SECS = await eamm.MIN_WINDOW_SECS();
      await eamm.connect(manager).openSealedWindow(MARKET_ID, MIN_SECS);

      // Advance Hardhat time past the window end.
      await ethers.provider.send('evm_increaseTime', [Number(MIN_SECS) + 1]);
      await ethers.provider.send('evm_mine', []);

      const enc = await fhevm
        .createEncryptedInput(eammAddress, alice.address)
        .add64(ONE_ETH)
        .encrypt();

      await expect(
        eamm.connect(alice).placeBet(MARKET_ID, true, enc.handles[0], enc.inputProof),
      ).to.be.revertedWithCustomError(eamm, 'WindowSettlementPending');
    });

    // ── settleSealedWindow ──────────────────────────────────────────────────

    it('cannot settle before the window expires', async () => {
      await eamm.connect(manager).openSealedWindow(MARKET_ID, WINDOW_SECS);
      await expect(
        eamm.connect(resolver).settleSealedWindow(MARKET_ID, 0n),
      ).to.be.revertedWithCustomError(eamm, 'WindowNotExpired');
    });

    it('resolver can settle an expired window', async () => {
      const MIN_SECS = await eamm.MIN_WINDOW_SECS();
      await eamm.connect(manager).openSealedWindow(MARKET_ID, MIN_SECS);

      await ethers.provider.send('evm_increaseTime', [Number(MIN_SECS) + 1]);
      await ethers.provider.send('evm_mine', []);

      await expect(
        eamm.connect(resolver).settleSealedWindow(MARKET_ID, 0n),
      ).to.emit(eamm, 'SealedWindowSettled').withArgs(MARKET_ID, 0n);

      const [, , settled] = await eamm.getSealedWindow(MARKET_ID, 0n);
      expect(settled).to.be.true;
    });

    it('cannot settle the same window twice', async () => {
      const MIN_SECS = await eamm.MIN_WINDOW_SECS();
      await eamm.connect(manager).openSealedWindow(MARKET_ID, MIN_SECS);

      await ethers.provider.send('evm_increaseTime', [Number(MIN_SECS) + 1]);
      await ethers.provider.send('evm_mine', []);

      await eamm.connect(resolver).settleSealedWindow(MARKET_ID, 0n);
      await expect(
        eamm.connect(resolver).settleSealedWindow(MARKET_ID, 0n),
      ).to.be.revertedWithCustomError(eamm, 'WindowAlreadySettled');
    });

    it('resolver can decrypt pool handles after settlement (settle-grants-decrypt)', async () => {
      // Alice bets YES before the window opens — pool has some ciphertext.
      const preEnc = await fhevm
        .createEncryptedInput(eammAddress, alice.address)
        .add64(ONE_ETH)
        .encrypt();
      await eamm.connect(alice).placeBet(MARKET_ID, true, preEnc.handles[0], preEnc.inputProof);

      // Open window, warp, settle.
      const MIN_SECS = await eamm.MIN_WINDOW_SECS();
      await eamm.connect(manager).openSealedWindow(MARKET_ID, MIN_SECS);
      await ethers.provider.send('evm_increaseTime', [Number(MIN_SECS) + 1]);
      await ethers.provider.send('evm_mine', []);
      await eamm.connect(resolver).settleSealedWindow(MARKET_ID, 0n);

      // Resolver can now decrypt the YES pool.
      const [yesHandle] = await eamm.getPoolHandles(MARKET_ID);
      const decryptedYes = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        yesHandle,
        eammAddress,
        resolver,
      );
      expect(decryptedYes).to.equal(ONE_ETH);
    });

    it('bets re-open after a window is settled', async () => {
      const MIN_SECS = await eamm.MIN_WINDOW_SECS();
      await eamm.connect(manager).openSealedWindow(MARKET_ID, MIN_SECS);
      await ethers.provider.send('evm_increaseTime', [Number(MIN_SECS) + 1]);
      await ethers.provider.send('evm_mine', []);
      await eamm.connect(resolver).settleSealedWindow(MARKET_ID, 0n);

      const enc = await fhevm
        .createEncryptedInput(eammAddress, alice.address)
        .add64(ONE_ETH)
        .encrypt();
      await expect(
        eamm.connect(alice).placeBet(MARKET_ID, true, enc.handles[0], enc.inputProof),
      ).to.emit(eamm, 'BetPlaced');
    });

    // ── publishWindowPrice ──────────────────────────────────────────────────

    it('resolver can publish decrypted price after settlement', async () => {
      const MIN_SECS = await eamm.MIN_WINDOW_SECS();
      await eamm.connect(manager).openSealedWindow(MARKET_ID, MIN_SECS);
      await ethers.provider.send('evm_increaseTime', [Number(MIN_SECS) + 1]);
      await ethers.provider.send('evm_mine', []);
      await eamm.connect(resolver).settleSealedWindow(MARKET_ID, 0n);

      await expect(
        eamm.connect(resolver).publishWindowPrice(MARKET_ID, 0n, 5_000_000n, 3_000_000n),
      ).to.emit(eamm, 'PriceRevealed').withArgs(MARKET_ID, 0n, 5_000_000n, 3_000_000n);
    });

    it('cannot publish price for an unsettled window', async () => {
      await eamm.connect(manager).openSealedWindow(MARKET_ID, WINDOW_SECS);
      await expect(
        eamm.connect(resolver).publishWindowPrice(MARKET_ID, 0n, 0n, 0n),
      ).to.be.revertedWithCustomError(eamm, 'WindowNotExpired');
    });

    // ── getActiveWindowIdx ──────────────────────────────────────────────────

    it('getActiveWindowIdx returns max uint when no window exists', async () => {
      const MAX = (2n ** 256n) - 1n;
      expect(await eamm.getActiveWindowIdx(MARKET_ID)).to.equal(MAX);
    });

    it('getActiveWindowIdx returns the current window index when active', async () => {
      await eamm.connect(manager).openSealedWindow(MARKET_ID, WINDOW_SECS);
      expect(await eamm.getActiveWindowIdx(MARKET_ID)).to.equal(0n);
    });

    it('getActiveWindowIdx returns max uint after a window is settled', async () => {
      const MIN_SECS = await eamm.MIN_WINDOW_SECS();
      await eamm.connect(manager).openSealedWindow(MARKET_ID, MIN_SECS);
      await ethers.provider.send('evm_increaseTime', [Number(MIN_SECS) + 1]);
      await ethers.provider.send('evm_mine', []);
      await eamm.connect(resolver).settleSealedWindow(MARKET_ID, 0n);

      const MAX = (2n ** 256n) - 1n;
      expect(await eamm.getActiveWindowIdx(MARKET_ID)).to.equal(MAX);
    });
  });

  // ── Access control: admin functions ───────────────────────────────────────

  describe('admin', () => {
    it('owner can update marketManager', async () => {
      await expect(
        eamm.connect(owner).setMarketManager(alice.address),
      ).to.emit(eamm, 'MarketManagerUpdated').withArgs(manager.address, alice.address);
      expect(await eamm.marketManager()).to.equal(alice.address);
    });

    it('owner can update resolver', async () => {
      await expect(
        eamm.connect(owner).setResolver(alice.address),
      ).to.emit(eamm, 'ResolverUpdated').withArgs(resolver.address, alice.address);
      expect(await eamm.resolver()).to.equal(alice.address);
    });

    it('reverts setMarketManager with zero address', async () => {
      await expect(
        eamm.connect(owner).setMarketManager(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(eamm, 'ZeroAddress');
    });

    it('owner can pause and unpause', async () => {
      await eamm.connect(owner).pause();
      // createMarket should fail while paused.
      await expect(
        eamm.connect(manager).createMarket(MARKET_ID, EXPIRY_1H),
      ).to.be.revertedWithCustomError(eamm, 'EnforcedPause');

      await eamm.connect(owner).unpause();
      await expect(
        eamm.connect(manager).createMarket(MARKET_ID, EXPIRY_1H),
      ).to.emit(eamm, 'MarketCreated');
    });

    it('non-owner cannot pause', async () => {
      await expect(
        eamm.connect(alice).pause(),
      ).to.be.revertedWithCustomError(eamm, 'OwnableUnauthorizedAccount');
    });
  });
});
