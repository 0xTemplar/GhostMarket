/**
 * debug-vault-deposit.ts
 *
 * Runs the full deposit flow against GhostVaultV2 on Sepolia using the
 * deployer key so we can see the *exact* revert reason in real time.
 *
 * Steps:
 *   1. Mint MockUSDC (if balance < requested amount)
 *   2. Approve cUSDCMock to spend MockUSDC
 *   3. Wrap MockUSDC → cUSDC
 *   4. Set GhostVaultV2 as operator on cUSDCMock
 *   5. Encrypt deposit amount for GhostVaultV2 via hre.fhevm
 *   6. Call GhostVaultV2.deposit()  ← catch exact revert here
 *
 * Run:
 *   npx hardhat run scripts/debug-vault-deposit.ts --network sepolia
 */

import { ethers, fhevm, network } from 'hardhat';
import dotenv from 'dotenv';
dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────

const MOCK_USDC_ADDRESS  = process.env.MOCK_USDC_ADDRESS  as `0x${string}`;
const CUSDC_MOCK_ADDRESS = process.env.CUSDC_MOCK_ADDRESS as `0x${string}`;
const GHOST_VAULT_ADDRESS = process.env.GHOST_VAULT_ADDRESS as `0x${string}`;

// Deposit 10 USDC (6 decimals)
const DEPOSIT_AMOUNT = 10_000_000n; // 10 USDC

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const MOCK_USDC_ABI = [
  'function mint(address to, uint256 amount) external',
  'function balanceOf(address) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
];

const CUSDC_MOCK_ABI = [
  'function wrap(address to, uint256 amount) external',
  'function setOperator(address operator, uint48 expiry) external',
  'function isOperator(address holder, address operator) external view returns (bool)',
  'function balanceOf(address) external view returns (uint256)',
];

const GHOST_VAULT_ABI = [
  'function deposit(bytes32 encAmount, bytes calldata proof) external',
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (network.name !== 'sepolia') {
    throw new Error('Run with --network sepolia');
  }

  // Must call initializeCLIApi for non-hardhat networks
  await fhevm.initializeCLIApi();

  const [signer] = await ethers.getSigners();
  console.log('\n=== GhostVaultV2 Deposit Debugger ===');
  console.log('Signer:       ', signer.address);
  console.log('MockUSDC:     ', MOCK_USDC_ADDRESS);
  console.log('cUSDCMock:    ', CUSDC_MOCK_ADDRESS);
  console.log('GhostVaultV2: ', GHOST_VAULT_ADDRESS);
  console.log('Amount:       ', DEPOSIT_AMOUNT.toString(), 'USDC base units');

  const mockUsdc = new ethers.Contract(MOCK_USDC_ADDRESS, MOCK_USDC_ABI, signer);
  const cusdcMock = new ethers.Contract(CUSDC_MOCK_ADDRESS, CUSDC_MOCK_ABI, signer);
  const vault = new ethers.Contract(GHOST_VAULT_ADDRESS, GHOST_VAULT_ABI, signer);

  // ── Step 1: Mint MockUSDC if needed ─────────────────────────────────────────
  const usdcBalance: bigint = await mockUsdc.balanceOf(signer.address);
  console.log('\n[1] MockUSDC balance:', usdcBalance.toString());
  if (usdcBalance < DEPOSIT_AMOUNT) {
    console.log('    Minting MockUSDC…');
    const tx = await mockUsdc.mint(signer.address, DEPOSIT_AMOUNT);
    await tx.wait();
    console.log('    Minted. tx:', tx.hash);
  } else {
    console.log('    Sufficient balance, skipping mint.');
  }

  // ── Step 2: Approve cUSDCMock to pull MockUSDC ───────────────────────────────
  const allowance: bigint = await mockUsdc.allowance(signer.address, CUSDC_MOCK_ADDRESS);
  console.log('\n[2] MockUSDC allowance for cUSDCMock:', allowance.toString());
  if (allowance < DEPOSIT_AMOUNT) {
    console.log('    Approving…');
    const tx = await mockUsdc.approve(CUSDC_MOCK_ADDRESS, DEPOSIT_AMOUNT);
    await tx.wait();
    console.log('    Approved. tx:', tx.hash);
  } else {
    console.log('    Allowance sufficient, skipping approve.');
  }

  // ── Step 3: Wrap MockUSDC → cUSDC ──────────────────────────────────────────
  console.log('\n[3] Wrapping MockUSDC → cUSDC…');
  try {
    const tx = await cusdcMock.wrap(signer.address, DEPOSIT_AMOUNT, { gasLimit: 600_000 });
    await tx.wait();
    console.log('    Wrapped. tx:', tx.hash);
  } catch (e: unknown) {
    console.error('    WRAP FAILED:', (e as Error).message?.slice(0, 200));
    // Don't abort — the user might already have cUSDC from a prior run
    console.log('    Continuing anyway (may already have cUSDC)…');
  }

  // ── Step 4: Set GhostVaultV2 as operator ───────────────────────────────────
  const isOp: boolean = await cusdcMock.isOperator(signer.address, GHOST_VAULT_ADDRESS);
  console.log('\n[4] Is vault operator?', isOp);
  if (!isOp) {
    console.log('    Setting operator…');
    const until = Math.floor(Date.now() / 1000) + 86400; // 24 h from now
    const tx = await cusdcMock.setOperator(GHOST_VAULT_ADDRESS, until, { gasLimit: 200_000 });
    await tx.wait();
    console.log('    Operator set. tx:', tx.hash);
  } else {
    console.log('    Already operator, skipping.');
  }

  // ── Step 5: Encrypt deposit amount for GhostVaultV2 ───────────────────────
  console.log('\n[5] Encrypting deposit amount via hre.fhevm…');
  console.log('    contractAddress:', GHOST_VAULT_ADDRESS);
  console.log('    userAddress:    ', signer.address);
  const input = fhevm.createEncryptedInput(GHOST_VAULT_ADDRESS, signer.address);
  input.add64(DEPOSIT_AMOUNT);
  const ciphertexts = await input.encrypt();
  const handle     = ciphertexts.handles[0] as `0x${string}`;
  const inputProof = ciphertexts.inputProof  as `0x${string}`;
  console.log('    handle:    ', handle);
  console.log('    inputProof:', typeof inputProof === 'string' ? inputProof.slice(0, 40) + '…' : '(bytes)');

  // ── Step 6: Call deposit — catch exact revert ──────────────────────────────
  console.log('\n[6] Calling GhostVaultV2.deposit()…');
  try {
    // First try a static call to get the revert reason without spending gas
    await vault.deposit.staticCall(handle, inputProof);
    console.log('    Static call PASSED — sending live tx…');
    const tx = await vault.deposit(handle, inputProof, { gasLimit: 1_000_000 });
    const receipt = await tx.wait();
    console.log('    DEPOSIT SUCCEEDED! tx:', tx.hash, 'gas used:', receipt?.gasUsed.toString());
  } catch (e: unknown) {
    const err = e as { message?: string; data?: string; reason?: string; errorName?: string; errorArgs?: unknown[] };
    console.error('\n    DEPOSIT FAILED!');
    console.error('    reason:    ', err.reason    ?? '(none)');
    console.error('    errorName: ', err.errorName ?? '(none)');
    console.error('    errorArgs: ', err.errorArgs ?? '(none)');
    console.error('    data:      ', err.data      ?? '(none)');
    console.error('    message:   ', err.message?.slice(0, 400) ?? '(none)');
  }
}

main().catch(console.error);
