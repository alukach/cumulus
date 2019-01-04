'use strict';

const cors = require('cors')
const hsts = require('hsts')
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const express = require('express')
const boom = require('express-boom')

const router = require('./routes')

const awsServerlessExpress = require('aws-serverless-express')
const app = express()

// Config
app.use(boom())
app.use(cors())
app.use(cookieParser());
app.use(bodyParser.json()); // for parsing application/json
app.use(hsts({ maxAge: 31536000 }))

app.use('/', router)

// global 404 response when page is not found
app.use(function (req, res, next) {
  res.boom.notFound('requested page not found');
})

// catch all error handling
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.boom.badImplementation('Something broke!')
});

const server = awsServerlessExpress.createServer(app, null)

module.exports = {
  app,
  handler: (event, context) => awsServerlessExpress.proxy(server, event, context)
}
