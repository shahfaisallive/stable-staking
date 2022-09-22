import axios from 'axios'
import express from 'express'
import cron from 'node-cron'
import * as SolanaWeb3 from '@solana/web3.js'
import cors from 'cors'
import dotenv from "dotenv"
import bs58 from "bs58"
import { getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { Metadata } from "@metaplex-foundation/mpl-token-metadata";
import * as splToken from "@solana/spl-token"

dotenv.config({ path: './.env' })
// dotenv.config({ path: './fake.env' })
const app = express()
app.use(express.json())

// CORS SETUP
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

app.use(cors({
    origin: "*",
    credentials: true,
}));

// maintaining data for verifications
let lastAirdropTime = null
let currentRewardAmounts = []
let failedStakeholders = []

// SOLANA CONNECTION SETUP
const connection = new SolanaWeb3.Connection(
    process.env.RPC_URL,
    "confirmed"
)
// const connection = new SolanaWeb3.Connection(
//     SolanaWeb3.clusterApiUrl('mainnet-beta')
// );

// PRIVATE KEY (SECURE IT LATER)
const privateKey = process.env.PRIVATE_KEY //Wallet of airdropper

// ACCOUNTS SETUP
const tokenAddress = process.env.REWARD_TOKEN //Reward token address
const fromAddress = process.env.AIRDROPPER_ADDRESS //Rewarder address (same as airdropper)
const fromPublicKey = new SolanaWeb3.PublicKey(fromAddress);
const tokenPublicKey = new SolanaWeb3.PublicKey(tokenAddress);
const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    fromPublicKey,
    tokenPublicKey,
    fromPublicKey,
);
const fromWallet = SolanaWeb3.Keypair.fromSecretKey(bs58.decode(privateKey));

// FUNCTION TO GET STAKED TOKENS AND DATA MODELLING
const getStakeholders = async () => {
    console.log("Getting staked tokens info through API")
    const stakedTokens = await axios.get("https://stables.solsuites.app/api/staking/mints")
    const stakeholders = stakedTokens.data.reduce((reducedArray, x) => {
        (reducedArray[x["owner"]] = reducedArray[x["owner"]] || []).push(x)
        return reducedArray
    }, {})
    const stakeholdersArray = Object.entries(stakeholders)

    return stakeholdersArray
}

// FUCNTION TO GET METADATA OF MINT ADDRESSES
const getMetadata = async (mintAddress) => {
    try {
        let mintPubkey = new SolanaWeb3.PublicKey(mintAddress)
        let tokenmetaPubkey = await Metadata.getPDA(mintPubkey)
        const tokenmeta = await Metadata.load(connection, tokenmetaPubkey);
        const jsonMetadata = await axios.get(tokenmeta.data.data.uri)
        return jsonMetadata.data
    } catch (error) {
        console.error(`FAILED!!! Couldn't fetch token metadata for ${mintAddress}`)
        return false
    }
}

// FUNCTION TO TRANSFER TOKENS
const transferReward = async (toAddress, amount) => {
    console.log(`<-----Reward Transfer Initiated----->`)

    // Variable for error handling
    let isTokenAccount = false
    const toPublicKey = new SolanaWeb3.PublicKey(toAddress);
    let toTokenAccount
    try {
        // CREATING TOKEN ACCOUNT FOR TRANSACTION
        toTokenAccount = await getOrCreateAssociatedTokenAccount(
            connection,
            fromPublicKey,
            tokenPublicKey,
            toPublicKey,
        )
        if (toTokenAccount) {
            console.log(`STBL Token Account found for ${toAddress}`)
            isTokenAccount = true
        }
    } catch (error) {
        isTokenAccount = false
        let failedObj = {}
        failedObj.stakeholder = toAddress
        failedObj.rewardCount = amount
        failedObj.reason = "No token account found for STBL token"
        failedStakeholders.push(failedObj)

        // console.log(error)
        console.error(`FAILED!!! couldn't GET any STBL token account for ${toAddress}`)
    };

    try {
        // SIGNATURE
        const signature = await splToken.transfer(
            connection,
            fromWallet,
            fromTokenAccount.address,
            toTokenAccount.address,
            fromWallet.publicKey,
            amount * Math.pow(10, process.env.DECIMALS)
        );
        console.log(signature)
        return signature
    } catch (error) {
        if (isTokenAccount) {
            let failedObj = {}
            failedObj.stakeholder = toAddress
            failedObj.rewardCount = amount
            failedObj.reason = "Unknown transfer error occured"
            failedStakeholders.push(failedObj)
            console.log(error)
            console.error(`FAILED!!! Couldn't transfer reward to ${toAddress}`)
        }
    }
}

// STABLES TYPES INFO OBJECT
const stallionBase = 2
const stablesTypes = {
    Racing: {
        hold: 1,
        multiplier: 2,
        base: 2
    },
    cowboy: {
        hold: 2,
        multiplier: 2,
        base: 6
    },
    medieval: {
        hold: 2,
        multiplier: 3,
        base: 8
    },
    degen: {
        hold: 3,
        multiplier: 3,
        base: 15
    },
    future: {
        hold: 3,
        multiplier: 4,
        base: 18
    },
    degen_animated: {
        hold: 4,
        multiplier: 5,
        base: 24
    },
    future_animated: {
        hold: 5,
        multiplier: 6,
        base: 30
    },
}

// REWARD CALCULATING ALGORITHM
const calculateReward = async (stakeholders) => {
    let stakeholdersRewards = []
    for (let i = 0; i < stakeholders.length; i++) {
        console.info(`<${i + 1}> Calculating REWARD for ${stakeholders[i][0]}: Total Staked: ${stakeholders[i][1].length}`)
        let rewardObj = {}
        let totalReward = 0
        let stallionStaked = []
        let stablesStaked = []

        for (let j = 0; j < stakeholders[i][1].length; j++) {
            console.info(`${j + 1}/${stakeholders[i][1].length}: Getting METADATA of ${stakeholders[i][1][j].mint}`)
            const metadata = await getMetadata(stakeholders[i][1][j].mint)
            if (metadata) {
                if (metadata.symbol == "SSNFTS") {
                    stallionStaked.push(stakeholders[i][1][j].mint)
                } else if (metadata.symbol == "STABLE") {
                    stablesStaked.push(metadata.attributes[0].value)
                } else {
                    console.log("Wrong Metadata token Found")
                }
            }
        }
        console.info(`${stallionStaked.length} stallions Staked by ${stakeholders[i][0]}`)
        console.log(stallionStaked)
        console.info(`${stablesStaked.length} stables Staked by ${stakeholders[i][0]}`)
        console.log(stablesStaked)

        const stallionsNum = stallionStaked.length
        const stablesNum = stablesStaked.length

        if (stallionsNum && stablesNum) {
            console.log('Both stallions and stables are staked')
            // Calculating reward for the stables staked according to their base emit
            stablesStaked.forEach(i => {
                let valueForEachStable = stablesTypes[i].base
                totalReward += valueForEachStable
            })
            // Calculating reward for the stallions according to the priority stables, their hold and multiplier
            let stablesPriority = ['future_animated', 'degen_animated', 'future', 'degen', 'medieval', 'cowboy', 'Racing']
            let stallionsCount = stallionsNum
            const configPriority = () => {
                for (let i = 0; i < stablesPriority.length; i++) {
                    for (let j = 0; j < stablesStaked.length; j++) {
                        if (stablesPriority[i] == stablesStaked[j]) {
                            if (stallionsCount <= stablesTypes[stablesPriority[i]].hold) {
                                // console.log("Stallion count is less than Stable Hold")
                                const rw = stallionsCount * stallionBase * stablesTypes[stablesPriority[i]].multiplier
                                totalReward += rw
                                stallionsCount -= stallionsCount
                                break;
                            } else {
                                // console.log("Stallion count is More than Stable Hold")
                                const rw = stablesTypes[stablesPriority[i]].hold * stallionBase * stablesTypes[stablesPriority[i]].multiplier
                                totalReward += rw
                                stallionsCount -= stablesTypes[stablesPriority[i]].hold
                                stablesStaked.splice(j, 1)
                                // console.log(stablesStaked)
                                configPriority()
                            }
                        }
                    }
                }
            }
            configPriority()
            if (!stallionsCount) {
                // console.log("All gone")
            } else {
                // console.log("Few stallions remaining")
                totalReward += stallionsCount * stallionBase
            }
        } else {
            console.log('Either of stallions and stables are staked')
            if (stablesNum) {
                // Calculating reward for the stables staked according to their base emit
                stablesStaked.forEach(i => {
                    let valueForEachStable = stablesTypes[i].base
                    totalReward += valueForEachStable
                })
            }
            if (stallionsNum) {
                // Calculating reward for stallions not held in stables
                totalReward += stallionsNum * stallionBase
            }
        }
        rewardObj.toAddress = stakeholders[i][0]
        rewardObj.rewardAmount = totalReward
        console.info(`${i + 1}: REWARD INFO FOR ${stakeholders[i][0]}: ${rewardObj.rewardAmount} tokens`)
        stakeholdersRewards.push(rewardObj)
        currentRewardAmounts.push(rewardObj)
    }
    return stakeholdersRewards

}

// MAIN AIRDROP FUNCTION
const airdrop = async () => {
    currentRewardAmounts = []
    failedStakeholders = []

    const stakeholders = await getStakeholders()
    console.log("STAKEHOLDERS RECEIVED", stakeholders.length)
    const stakeholdersRewards = await calculateReward(stakeholders)
    console.log(stakeholdersRewards)
    currentRewardAmounts = stakeholdersRewards

    const signatures = []
    for (let i = 0; i < stakeholdersRewards.length; i++) {
        const signature = await transferReward(stakeholdersRewards[i].toAddress, stakeholdersRewards[i].rewardAmount)
        if (signature) {
            signatures.push(signature)
            console.info(`${i + 1}/${stakeholdersRewards.length}: Transferred ${stakeholdersRewards[i].rewardAmount} reward tokens to ${stakeholdersRewards[i].toAddress}`)
        }
    }
    console.log('<<<<>>>>>ALL TRANSACTIONS SUCCESSFULL<<<<>>>>>')
}

// CRON JOB CONFIGURATION
cron.schedule("00 00 07 * * *", async () => {
    console.info(`<<<<<-----AIRDROP PROCEDURE INITIATING----->>>>>`)
    await airdrop()
    let time = new Date()
    lastAirdropTime = time
    console.info(`<<<<<-----SUCCESSFULL AIRDROP COMPLETED----->>>>>`)
    console.info(`<<<---DATE: ${time}--->>>`)
    console.log(`<<<<<-----PLEASE WAIT FOR NEXT AIRDROP----->>>>>`)
})

app.get("/api/airdrop", async (req, res) => {
    res.send({
        active: true,
        msg: "Yes! the airdrop is alive and running",
        lastAirdrop: lastAirdropTime,
        totalStakeholders: currentRewardAmounts.length,
        currentRewardCount: currentRewardAmounts,
        noTokenAccountStakeholders: failedStakeholders
    })
})

// SERVER LISTENING
const PORT = process.env.PORT || 4000
app.listen(PORT, () => {
    console.log('Server is running successfully on Port: ' + PORT)
})
