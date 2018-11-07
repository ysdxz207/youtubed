const Koa = require('koa');
const Router = require('koa-router');
const app = new Koa();
const router = new Router();
const { execSync, spawn } = require('child_process')
const views = require('koa-views')
const send = require('koa-send')
const koaBody = require('koa-body')
const path = require('path')
const fs = require('fs')

let FILE_PATH = '/app/video/videos/'
let FILE_DOWNLOADING_CACHE = '/app/video/videos/downloading.cache'

app.use(koaBody())

app.use(views(path.join(__dirname, './views'), {
    extension: 'ejs'
}))

app.use(async (ctx, next) => {
  try {
    await next()

    const status = ctx.status || 404
    if (status === 404) {
      ctx.throw(404)
    }
  } catch (err) {
    ctx.status = err.status || 500
    if (ctx.status === 404) {
      ctx.body = {
        message : '404'
      }
    } else {
      ctx.body = {
        message : 'other error'
      }
    }
  }
})


router.get('/', async (ctx, next) => {
    await ctx.render('index')
})

router.get('/downloadLocal/:name', async (ctx, next) => {
    let filename = `videos/${ctx.params.name}`
    ctx.attachment(filename);
    await send(ctx, filename)
})

router.get('/watch/:name', async (ctx, next) => {
    let filename = `${ctx.params.name}`
    let filepath = `/video/${filename}`
    await ctx.render('watch', {
        name: `${filename}`,
        url: filepath
    })
})

router.post('/list', async (ctx, next) => {
    let result = {}
    let execCommand = `youtube-dl -F ${ctx.request.body.url}`
    console.log(`exec command:${execCommand}`)
    let stdout
    try {
        result.statusCode = 200
        stdout = execSync(execCommand).toString()
        stdout = stdout.split('\n')
        stdout = stdout.slice(4, stdout.length)
        result.list = parseToInfoList(stdout)
    } catch (e) {
        result.statusCode = 300
        result.message = e.stderr.toString()
        result.list = []
    }
    result.total = result.list.length
    ctx.body = result
})


router.post('/predownload', async (ctx, next) => {
    let result = {}
    let num = ctx.request.body.num
    let url = ctx.request.body.url
    let resolution = ctx.request.body.resolution
    try {
        result.statusCode = 200
        let filenameTemp = '%(title)s_' + resolution + '.%(ext)s'
        let filepathTemp = `${FILE_PATH}${filenameTemp}`
        let sp = spawn('youtube-dl', ['-f', num, url, '-o', filepathTemp])
        // 获取文件名
        let filename = execSync(`youtube-dl --get-filename -o \'${filenameTemp}\' -f ${num} ${url}`).toString().replace('\n', '')

        let progressFile = `${FILE_PATH}${filename}.progress`
        // 创建进度文件
        if (fs.existsSync(progressFile)) {
            result.statusCode = 300
            result.message = '请勿重复下载'
            ctx.body = result
            return
        }

        // 一次只能下载一个
        if (fs.existsSync(FILE_DOWNLOADING_CACHE)) {
            result.statusCode = 300
            result.message = '请等待队列中任务完成'
            ctx.body = result
            return
        }

        console.log(`Create progress file:${progressFile}`)
        fs.appendFileSync(progressFile, '')

        console.log('Create downloading.cache.')
        fs.appendFileSync(FILE_DOWNLOADING_CACHE, '')

        sp.stdout.on('data', function (msg) {
            let downloadInfo = parseDownloadInfo(msg.toString())
            if (downloadInfo) {

                fs.appendFile(progressFile, JSON.stringify(downloadInfo) + '\n', function (err) {
                    if (err) {
                        console.error(err)
                    }
                })

                if (parseInt(downloadInfo.percent) === 1 && fs.existsSync(FILE_DOWNLOADING_CACHE)) {
                    console.log('Delete downloading.cache.')
                    fs.unlinkSync(FILE_DOWNLOADING_CACHE)
                }
            }
        })

        result.message = '已加入离线下载队列'
        result.filename = filename
    } catch (e) {
        result.statusCode = 300
        result.message = e.stderr.toString()
    }
    ctx.body = result
})


router.get('/downloadList', async (ctx, next) => {
    let result = {
        statusCode: 200
    }

    if (!fs.existsSync(FILE_PATH)) {
        result.list = []
    } else {

        let files = fs.readdirSync(FILE_PATH)
        let progressFiles = []
        files.forEach(function (name, index) {
            if (path.extname(name) === '.progress') {
                let progressFileName = `${FILE_PATH}${name}`
                name = name.replace('.progress', '')
                try {
                    if (fs.existsSync(progressFileName)) {
                        let fileContent = fs.readFileSync(progressFileName).toString()
                        let progressFile = {}
                        if (fileContent.trim()) {
                            let arr = fileContent.split('\n')
                            let lastDownloadInfo = arr[arr.length - 2]
                            lastDownloadInfo = JSON.parse(lastDownloadInfo)
                            progressFile.percent = lastDownloadInfo.percent
                            progressFile.percentStr = lastDownloadInfo.percentStr
                        } else {
                            progressFile.percent = 1
                            progressFile.percentStr = '100%'
                        }
                        progressFile.name = name
                        progressFiles.push(progressFile)

                    }
                } catch (e) {
                    console.log(e)
                }
            }
        })

        result.total = progressFiles.length
        result.list = progressFiles
    }
    ctx.body = result
})

let parseToInfoList = function(arr) {
    let result = []

    for (let i = 0; i < arr.length; i ++) {
        if (arr[i].indexOf('720p') !== -1 || arr[i].indexOf('1080p') !== -1 || arr[i].indexOf('hd720') !== -1) {
            let info = {}
            let inf = arr[i].replace(/\s+/g, '*').split('*')
            let num = inf[0]
            inf = inf.slice(1, inf.length)

            let size = inf[inf.length - 1]
            if (size.indexOf('MiB') !== -1) {
                size = size.replace('MiB', '')
            } else {
                size = '未知'
            }
            info.num = num
            info.format = inf[2] + '/' + inf[0]
            info.resolution = inf[1]
            info.size = size
            result.push(info)
        }
    }
    return result
}

let parseDownloadInfo = function(msg) {
    let info = {}
    let regPercent = /\d+(\.\d+)?%/
    let regSize = /\d+(\.\d+)?MiB\s/
    let regSpeed = /\d+(\.\d+)?MiB\/s/

    let resultPercent = msg.match(regPercent)
    let resultSize = msg.match(regSize)
    let resultSpeed = msg.match(regSpeed)

    if (resultPercent) {
        info.percent = (parseInt(resultPercent) / 100).toFixed(2)
        info.percentStr = parseInt(info.percent * 100) + '%'
    }

    if (resultSize) {
        info.size = parseInt(resultSize)
    }

    if (resultSpeed) {
        info.speed = parseInt(resultSpeed)
    }

    if (info.percent && info.size) {
        info.completeSize = (info.percent * info.size).toFixed(2)
    }

    if (JSON.stringify(info) === '{}') {
        return null
    }
    for(let x in info) {
        if (!info[x]) {
            return null
        }
    }
    return info
}

app.use(router.routes())
app.listen(8000)
