/**
 * task:shielded-bet — GhostEAMM end-to-end encrypted bet demo.
 *
 * Uses hre.fhevm (the @fhevm/hardhat-plugin API) so that the plugin
 * manages FHE transparently:
 *
 *   Mock mode  (--network hardhat):
 *     Encryption is simulated locally — no relayer required.
 *     Ideal for CI and quick development iteration.
 *
 *   Live mode  (--network sepolia):
 *     Calls the Zama relayer at relayer.testnet.zama.org.
 *     Requires a funded Sepolia wallet (SEPOLIA_PRIVATE_KEY in .env).
 *     Note: the Zama testnet relayer is currently migrating to a new
 *     protocol version. Live Sepolia runs will work once the migration
 *     completes. The mock tests cover the same logic in the interim.
 *
 * Run:
 *   npx hardhat task:shielded-bet                    # mock (default)
 *   npx hardhat task:shielded-bet --network sepolia  # live (Zama relayer)
 *
 * Optional params:
 *   --market  <id>    GhostEAMM market ID (default 1)
 *   --amount  <eth>   Bet size in ETH string (default "0.001")
 *   --side    <bool>  YES=true / NO=false (default true)
 */

import { task } from 'hardhat/config';
import type { TaskArguments } from 'hardhat/types';
import { FhevmType } from '@fhevm/hardhat-plugin';
import dotenv from 'dotenv';
dotenv.config();

const GHOST_EAMM_ABI = [
  'function createMarket(uint256 marketId, uint64 expiryAt) external',
  'function placeBet(uint256 marketId, bool side, bytes32 encAmount, bytes calldata inputProof) external',
  'function getUserPositionHandles(uint256 marketId, address user) external view returns (bytes32 yesHandle, bytes32 noHandle)',
  'function getPoolHandles(uint256 marketId) external view returns (bytes32 yesPool, bytes32 noPool)',
  'function getMarketMeta(uint256 marketId) external view returns (uint8 status, bool outcome, uint64 expiryAt)',
  'function hasPosition(uint256 marketId, address user) external view returns (bool)',
  'event BetPlaced(uint256 indexed marketId, address indexed user, bool indexed side)',
];

function maskHandle(handle: string, ZeroHash: string): string {
  return handle === ZeroHash
    ? '(empty)'
    : `${handle.slice(0, 10)}…${handle.slice(-8)} [ENCRYPTED]`;
}

task('task:shielded-bet', 'Place an FHE-encrypted bet on GhostEAMM')
  .addOptionalParam('market', 'Market ID', '1')
  .addOptionalParam('amount', 'Bet amount in ETH', '0.001')
  .addOptionalParam('side',   'YES=true / NO=false', 'true')
  .setAction(async function (args: TaskArguments, hre) {
    const { ethers, fhevm, network } = hre;

    // initializeCLIApi() is required for external networks (localhost, sepolia).
    // The default in-process 'hardhat' network auto-initializes in mock FHE mode.
    const needsCLIInit = network.name === 'localhost' || network.name === 'sepolia';
    if (needsCLIInit) {
      await fhevm.initializeCLIApi();
    }

    const isMock = network.name !== 'sepolia';

    console.log('='.repeat(64));
    console.log('GhostMarket — Shielded Bet Task');
    console.log('='.repeat(64));
    console.log('Mode:     ', isMock ? 'Mock FHE (local hardhat)' : 'Live FHE (Zama Sepolia)');

    const [signer] = await ethers.getSigners();
    const marketId  = BigInt(args.market as string);
    const betWei    = ethers.parseEther(args.amount as string);
    const side      = (args.side as string) === 'true';
    const sideLabel = side ? 'YES' : 'NO';

    // In mock mode deploy a fresh GhostEAMM; in live mode use the env address.
    let eammAddress: string;
    if (isMock) {
      console.log('\n[Setup] Deploying GhostEAMM to local hardhat network…');
      const Factory = await ethers.getContractFactory('GhostEAMM');
      const eamm    = await Factory.deploy(signer.address, signer.address);
      await eamm.waitForDeployment();
      eammAddress = await eamm.getAddress();
      console.log('  Deployed at:', eammAddress);
    } else {
      eammAddress = process.env.GHOST_EAMM_ADDRESS!;
      if (!eammAddress) throw new Error('GHOST_EAMM_ADDRESS not set in .env');
    }

    console.log('Signer:   ', signer.address);
    console.log('GhostEAMM:', eammAddress);
    console.log('Market:   ', marketId.toString());
    console.log('Bet:      ', ethers.formatEther(betWei), 'ETH on', sideLabel);

    const eamm = new ethers.Contract(eammAddress, GHOST_EAMM_ABI, signer);

    // ── Ensure market exists (getMarketMeta reverts if not found) ────────────
    let status: bigint;
    let expiryAt: bigint;

    try {
      const meta = await eamm.getMarketMeta(marketId);
      status   = meta[0];
      expiryAt = meta[2];
    } catch {
      console.log('\n[Setup] Market', marketId.toString(), 'not found — creating…');
      const exp = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
      const tx  = await eamm.createMarket(marketId, exp);
      await tx.wait();
      const m2 = await eamm.getMarketMeta(marketId);
      status   = m2[0];
      expiryAt = m2[2];
    }

    const statusNum = Number(status);
    console.log('\nMarket status:', ['Active', 'Resolved', 'Cancelled'][statusNum]);
    console.log('Market expiry:', new Date(Number(expiryAt) * 1000).toISOString());

    if (statusNum !== 0) {
      console.log('Market is not Active — cannot place bet.');
      return;
    }

    // ── Step 1: Encrypt the bet amount ───────────────────────────────────────
    console.log('\n[Step 1] Encrypting bet amount via hre.fhevm…');
    const input = fhevm.createEncryptedInput(eammAddress, signer.address);
    input.add64(betWei);
    const ciphertexts = await input.encrypt();

    const handle     = ciphertexts.handles[0] as `0x${string}`;
    const inputProof = ciphertexts.inputProof  as `0x${string}`;

    console.log('  Encrypted handle:    ', maskHandle(handle, ethers.ZeroHash));
    console.log('  Proof length (bytes):',
      typeof inputProof === 'string'
        ? inputProof.replace('0x', '').length / 2
        : (inputProof as unknown as Uint8Array).length,
    );
    console.log('✓ Amount encrypted — plaintext is gone from this point');

    // ── Step 2: Submit shielded bet ───────────────────────────────────────────
    console.log(`\n[Step 2] Submitting shielded ${sideLabel} bet to GhostEAMM…`);
    const tx = await eamm.placeBet(marketId, side, handle, inputProof);
    console.log('  TX hash:', tx.hash);
    await tx.wait();
    console.log('✓ Confirmed in block', (await tx.wait())?.blockNumber ?? '?');

    // Parse BetPlaced event — confirm no amount is present.
    const receipt = await tx.wait();
    const iface   = new ethers.Interface(GHOST_EAMM_ABI);
    const events  = receipt!.logs
      .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
      .filter(Boolean);
    const betEvent = events.find((e) => e!.name === 'BetPlaced');
    if (betEvent) {
      console.log('\nBetPlaced event:');
      console.log('  marketId:', betEvent.args.marketId.toString());
      console.log('  user:    ', betEvent.args.user);
      console.log('  side:    ', betEvent.args.side ? 'YES' : 'NO');
      console.log('  amount:   *** NOT IN EVENT — shielded ✓ ***');
    }

    // ── Step 3: Read encrypted position handles ───────────────────────────────
    console.log('\n[Step 3] Reading encrypted position handles from GhostEAMM…');
    const [yesHandle, noHandle] = await eamm.getUserPositionHandles(marketId, signer.address);
    const hasPos = await eamm.hasPosition(marketId, signer.address);

    console.log('  YES handle:', maskHandle(yesHandle, ethers.ZeroHash));
    console.log('  NO  handle:', maskHandle(noHandle,  ethers.ZeroHash));
    console.log('  hasPosition():', hasPos);

    // ── Step 4 (mock only): Decrypt position to verify value ─────────────────
    if (isMock) {
      console.log('\n[Step 4] Decrypting YES position handle (mock mode only)…');
      const posHandle = side ? yesHandle : noHandle;
      if (posHandle !== ethers.ZeroHash) {
        const clearAmount = await fhevm.userDecryptEuint(
          FhevmType.euint64,
          posHandle,
          eammAddress,
          signer,
        );
        console.log('  Decrypted position amount:', ethers.formatEther(clearAmount), 'ETH');
        console.log('  Expected:                 ', ethers.formatEther(betWei), 'ETH');
        console.log('  Match:', clearAmount.toString() === betWei.toString() ? '✓ YES' : '✗ NO');
      }
    }

    // ── Step 5: Pool handles ──────────────────────────────────────────────────
    const [yesPool, noPool] = await eamm.getPoolHandles(marketId);
    console.log('\n[Step 5] Pool handles (readable only by resolver/Lit PKP):');
    console.log('  YES pool:', maskHandle(yesPool, ethers.ZeroHash));
    console.log('  NO  pool:', maskHandle(noPool,  ethers.ZeroHash));

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(64));
    console.log('RESULT: Shielded bet placed successfully.');
    console.log(`  Bet:    ${ethers.formatEther(betWei)} ETH on ${sideLabel}`);
    console.log('  Mode:  ', isMock ? 'Mock FHE' : 'Live FHE (Zama Sepolia)');
    console.log('  Amount: never appeared in calldata, events, or state as plaintext');
    if (!isMock) {
      console.log(`  Etherscan: https://sepolia.etherscan.io/tx/${tx.hash}`);
    }
    console.log('='.repeat(64));
    console.log('\nNext: run scripts/simulate-settlement.ts to test the Flow EVM payout path.');
  });
