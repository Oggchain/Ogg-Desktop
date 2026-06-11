// OGG Desktop — Wallet Logic
// All contract calls, validations, keystore management

const RPC = 'https://rpc.oggcoin.org'
const RPC_FALLBACKS = ['http://85.190.254.195:18545','http://85.190.254.196:18547','http://81.17.99.108:18545']
const CHAIN_ID = 70088
const CHAIN_HEX = '0x111c8'
const EXPLORER = 'https://scan.oggcoin.org'

// Contract addresses
const CONTRACTS = {
  staking:   '0xa47008c59f729756bEc7d01f6FE71328A242d0c4',  // OGGStaking v3
  tribePool: '0x085CF5da09842FA3BA01068CC02c156198b1b114',  // TribePool
  vesting:   '0x1B24BD66921f821fF034285A8528EB31F12bFF66',  // VestingContract
  tokenVest: '0xca614Bba495fC5FE437D57CFf5eD7e6df84f0229',  // TokenVesting
}

// Minimum stake to create proposal
const MIN_STAKE_FOR_PROPOSAL = ethers.utils.parseEther('100000')  // 100k OGG
const MIN_STAKE_OGG = ethers.utils.parseEther('1000000')          // 1M OGG recommended

const STAKING_ABI = [
  'function stake(uint256 amount) external',
  'function unstake(uint256 amount) external',
  'function withdraw() external',
  'function claimReward() external',
  'function earned(address account) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function totalSupply() external view returns (uint256)',
  'function cooldownOf(address account) external view returns (uint256)',
  'function cooldownEnd(address account) external view returns (uint256)',
]

const TRIBE_ABI = [
  'function propose(string title, string description, uint256 amount) external',
  'function vote(uint256 proposalId, bool support) external',
  'function finalize(uint256 proposalId) external',
  'function getProposal(uint256 id) external view returns (string,string,uint256,uint256,uint256,uint256,bool)',
  'function proposalCount() external view returns (uint256)',
  'function balanceOf() external view returns (uint256)',
]

let provider = null
let wallet = null   // ethers.Wallet
let signer = null

// Keystores stored in memory (in production: encrypted to userData via fs)
let keystores = []  // [{name, address, keystore (encrypted JSON)}]
let activeKeystore = null

// ─── Provider ───────────────────────────────────────────
async function initProvider() {
  const urls = [RPC, ...RPC_FALLBACKS]
  for (const url of urls) {
    try {
      const p = new ethers.providers.JsonRpcProvider(url)
      await p.getNetwork()
      provider = p
      console.log('Connected to', url)
      return true
    } catch(e) {
      console.warn('RPC failed:', url)
    }
  }
  return false
}

async function getBlock() {
  try {
    const b = await provider.getBlockNumber()
    return b
  } catch { return null }
}

// ─── Keystore ────────────────────────────────────────────
// In production these are saved to userData path via fs
// Here we use localStorage as stand-in
function loadKeystores() {
  try {
    const raw = localStorage.getItem('ogg-keystores')
    keystores = raw ? JSON.parse(raw) : []
  } catch { keystores = [] }
}

function saveKeystores() {
  localStorage.setItem('ogg-keystores', JSON.stringify(keystores))
}

async function createWallet(name, password) {
  if (!name || name.trim() === '') throw new Error('Wallet name is required')
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters')
  const w = ethers.Wallet.createRandom()
  const encrypted = await w.encrypt(password)
  const entry = { name: name.trim(), address: w.address, keystore: encrypted }
  keystores.push(entry)
  saveKeystores()
  return { address: w.address, privateKey: w.privateKey }
}

async function importWallet(name, privateKey, password) {
  if (!name || name.trim() === '') throw new Error('Wallet name is required')
  if (!privateKey || privateKey.trim() === '') throw new Error('Private key is required')
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters')
  let w
  try {
    w = new ethers.Wallet(privateKey.trim())
  } catch(e) {
    throw new Error('Invalid private key')
  }
  // Check duplicate
  if (keystores.find(k => k.address.toLowerCase() === w.address.toLowerCase())) {
    throw new Error('This wallet is already imported')
  }
  const encrypted = await w.encrypt(password)
  const entry = { name: name.trim(), address: w.address, keystore: encrypted }
  keystores.push(entry)
  saveKeystores()
  return { address: w.address }
}

async function unlockWallet(address, password) {
  const entry = keystores.find(k => k.address.toLowerCase() === address.toLowerCase())
  if (!entry) throw new Error('Wallet not found')
  try {
    wallet = await ethers.Wallet.fromEncryptedJson(entry.keystore, password)
    if (!provider) await initProvider()
    signer = wallet.connect(provider)
    activeKeystore = entry
    return { address: wallet.address, name: entry.name }
  } catch(e) {
    throw new Error('Wrong password')
  }
}

function lockWallet() {
  wallet = null
  signer = null
  activeKeystore = null
}

function deleteWallet(address) {
  keystores = keystores.filter(k => k.address.toLowerCase() !== address.toLowerCase())
  saveKeystores()
}

// ─── Wallet info ─────────────────────────────────────────
async function getBalance(address) {
  if (!provider) await initProvider()
  const bal = await provider.getBalance(address)
  return bal
}

async function getStakingInfo(address) {
  if (!provider) await initProvider()
  const contract = new ethers.Contract(CONTRACTS.staking, STAKING_ABI, provider)
  const [staked, rewards, cooldown, cooldownEnd, total] = await Promise.all([
    contract.balanceOf(address),
    contract.earned(address),
    contract.cooldownOf(address),
    contract.cooldownEnd(address),
    contract.totalSupply(),
  ])
  return { staked, rewards, cooldown, cooldownEnd, total }
}

// ─── Send ────────────────────────────────────────────────
async function sendOGG(to, amount) {
  requireSigner()
  if (!ethers.utils.isAddress(to)) throw new Error('Invalid recipient address')
  const amtWei = ethers.utils.parseEther(amount.toString())
  if (amtWei.lte(0)) throw new Error('Amount must be greater than 0')

  // Check balance
  const bal = await provider.getBalance(signer.address)
  const gasPrice = await provider.getGasPrice()
  const gasLimit = ethers.BigNumber.from('21000')
  const gasCost = gasPrice.mul(gasLimit)
  if (bal.lt(amtWei.add(gasCost))) throw new Error('Insufficient balance (including gas)')

  const tx = await signer.sendTransaction({ to, value: amtWei, gasLimit })
  return tx
}

// ─── Staking ─────────────────────────────────────────────
async function stakeOGG(amount) {
  requireSigner()
  const amtWei = ethers.utils.parseEther(amount.toString())
  if (amtWei.lte(0)) throw new Error('Amount must be greater than 0')
  const bal = await provider.getBalance(signer.address)
  const gasEst = ethers.utils.parseEther('0.01') // reserve for gas
  if (bal.lt(amtWei.add(gasEst))) throw new Error('Insufficient balance (reserve some OGG for gas)')

  const contract = new ethers.Contract(CONTRACTS.staking, STAKING_ABI, signer)
  const tx = await contract.stake(amtWei, { value: amtWei })
  return tx
}

async function unstakeOGG(amount) {
  requireSigner()
  const amtWei = ethers.utils.parseEther(amount.toString())
  if (amtWei.lte(0)) throw new Error('Amount must be greater than 0')
  const contract = new ethers.Contract(CONTRACTS.staking, STAKING_ABI, signer)
  const staked = await contract.balanceOf(signer.address)
  if (staked.lt(amtWei)) throw new Error(`Insufficient staked balance. You have ${ethers.utils.formatEther(staked)} OGG staked`)
  const tx = await contract.unstake(amtWei)
  return tx
}

async function claimRewards() {
  requireSigner()
  const contract = new ethers.Contract(CONTRACTS.staking, STAKING_ABI, signer)
  const rewards = await contract.earned(signer.address)
  if (rewards.lte(0)) throw new Error('No rewards to claim')
  const tx = await contract.claimReward()
  return tx
}

async function withdrawCooldown() {
  requireSigner()
  const contract = new ethers.Contract(CONTRACTS.staking, STAKING_ABI, signer)
  const cooldown = await contract.cooldownOf(signer.address)
  if (cooldown.lte(0)) throw new Error('No OGG in cooldown to withdraw')
  const endTime = await contract.cooldownEnd(signer.address)
  const now = Math.floor(Date.now() / 1000)
  if (endTime.toNumber() > now) {
    const remaining = endTime.toNumber() - now
    const hours = Math.ceil(remaining / 3600)
    throw new Error(`Cooldown not ended yet. ${hours} hours remaining`)
  }
  const tx = await contract.withdraw()
  return tx
}

// ─── Tribe Pool ──────────────────────────────────────────
async function createProposal(title, description, amount) {
  requireSigner()
  if (!title || title.trim() === '') throw new Error('Proposal title is required')
  if (!description || description.trim() === '') throw new Error('Proposal description is required')

  // Check minimum stake
  const contract = new ethers.Contract(CONTRACTS.staking, STAKING_ABI, provider)
  const staked = await contract.balanceOf(signer.address)
  if (staked.lt(MIN_STAKE_FOR_PROPOSAL)) {
    throw new Error(`You need at least 100,000 OGG staked to create a proposal. You have ${parseFloat(ethers.utils.formatEther(staked)).toFixed(0)} OGG staked`)
  }

  const amtWei = ethers.utils.parseEther(amount.toString())
  const tribe = new ethers.Contract(CONTRACTS.tribePool, TRIBE_ABI, signer)
  const tx = await tribe.propose(title.trim(), description.trim(), amtWei)
  return tx
}

async function voteOnProposal(proposalId, support) {
  requireSigner()
  // Check has stake to vote
  const staking = new ethers.Contract(CONTRACTS.staking, STAKING_ABI, provider)
  const staked = await staking.balanceOf(signer.address)
  if (staked.lte(0)) throw new Error('You need staked OGG to vote on proposals')
  const tribe = new ethers.Contract(CONTRACTS.tribePool, TRIBE_ABI, signer)
  const tx = await tribe.vote(proposalId, support)
  return tx
}

// ─── Helpers ─────────────────────────────────────────────
function requireSigner() {
  if (!signer) throw new Error('Wallet is locked. Please unlock your wallet first.')
}

function formatOGG(wei, decimals) {
  decimals = decimals || 2
  const n = parseFloat(ethers.utils.formatEther(wei.toString()))
  if (n >= 1000000) return (n/1000000).toFixed(2) + 'M'
  if (n >= 1000) return (n/1000).toFixed(2) + 'K'
  return n.toFixed(decimals)
}

function shortAddr(addr) {
  return addr ? addr.slice(0,8) + '...' + addr.slice(-6) : '—'
}

function tsToDate(ts) {
  if (!ts || ts === 0) return '—'
  return new Date(Number(ts) * 1000).toLocaleDateString('en-GB', {
    day:'2-digit', month:'short', year:'numeric',
    hour:'2-digit', minute:'2-digit'
  })
}

// Gas estimate helper
async function estimateGas(txRequest) {
  try {
    const gasPrice = await provider.getGasPrice()
    const gasLimit = await provider.estimateGas(txRequest)
    const cost = gasPrice.mul(gasLimit)
    return { gasPrice, gasLimit, cost, formatted: ethers.utils.formatEther(cost) + ' OGG' }
  } catch(e) {
    return { formatted: '~0.001 OGG' }
  }
}

// Export for use in renderer
if (typeof module !== 'undefined') {
  module.exports = {
    initProvider, getBlock, getBalance, getStakingInfo,
    createWallet, importWallet, unlockWallet, lockWallet, deleteWallet,
    loadKeystores, saveKeystores,
    sendOGG, stakeOGG, unstakeOGG, claimRewards, withdrawCooldown,
    createProposal, voteOnProposal,
    formatOGG, shortAddr, tsToDate, estimateGas,
    CONTRACTS, CHAIN_ID, EXPLORER,
    get keystores() { return keystores },
    get wallet() { return wallet },
    get signer() { return signer },
    get provider() { return provider },
    get activeKeystore() { return activeKeystore },
  }
}
