/*****
 License
 --------------
 Copyright © 2017 Bill & Melinda Gates Foundation
 The Mojaloop files are made available by the Bill & Melinda Gates Foundation under the Apache License, Version 2.0 (the "License") and you may not use these files except in compliance with the License. You may obtain a copy of the License at

 http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, the Mojaloop files are distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

 Contributors
 --------------
 This is the official list of the Mojaloop project contributors for this file.
 Names of the original copyright holders (individuals or organizations)
 should be listed with a '*' in the first column. People who have
 contributed from an organization can be listed under the organization
 that actually holds the copyright for their contributions (see the
 Gates Foundation organization for an example). Those individuals should have
 their names indented and be marked with a '-'. Email address can be added
 optionally within square brackets <email>.

 * Gates Foundation
 - Name Surname <name.surname@gatesfoundation.com>

 * ModusBox
 - Georgi Georgiev <georgi.georgiev@modusbox.com>
 - Rajiv Mothilal <rajiv.mothilal@modusbox.com>
 - Miguel de Barros <miguel.debarros@modusbox.com>
 - Deon Botha <deon.botha@modusbox.com>
 - Shashikant Hirugade <shashikant.hirugade@modusbox.com>

 --------------
 ******/
'use strict'

/**
 * @module src/handlers/transfers
 */

const Logger = require('@mojaloop/central-services-logger')
const EventSdk = require('@mojaloop/event-sdk')
const TransferService = require('../../domain/transfer')
const Util = require('@mojaloop/central-services-shared').Util
const Kafka = require('@mojaloop/central-services-shared').Util.Kafka
const Producer = require('@mojaloop/central-services-stream').Util.Producer
const Consumer = require('@mojaloop/central-services-stream').Util.Consumer
const Validator = require('./validator')
const Enum = require('@mojaloop/central-services-shared').Enum
const TransferState = Enum.Transfers.TransferState
const TransferEventType = Enum.Events.Event.Type
const TransferEventAction = Enum.Events.Event.Action
const TransferObjectTransform = require('../../domain/transfer/transform')
const Metrics = require('@mojaloop/central-services-metrics')
const Config = require('../../lib/config')
const decodePayload = require('@mojaloop/central-services-shared').Util.StreamingProtocol.decodePayload
const Comparators = require('@mojaloop/central-services-shared').Util.Comparators
const ErrorHandler = require('@mojaloop/central-services-error-handling')

const PREPARE_DUPLICATE_INSERT_MODE = process.env.PREPARE_DUPLICATE_INSERT_MODE
const FULFIL_DUPLICATE_INSERT_MODE = process.env.FULFIL_DUPLICATE_INSERT_MODE
const PREPARE_SEND_POSITION_TO_KAFKA = !(process.env.PREPARE_SEND_POSITION_TO_KAFKA_DISABLED === 'true')

// ### START: PERF_TEST kafka.proceed
const { proceedToPosition } = require('../../../test/perf/src/util/prepare')
// PERF_TEST

// ### START: Placeholder for modifing Comparators.duplicateCheckComparator algorithm to use an insert only method for duplicate checking
const Crypto = require('crypto') // copied from @mojaloop/central-services-shared/src/util/hash.js <- to be removed once duplicate-check algorithm test changes are reverted, or made permanent.
function generateSha256 (object) { // copied from @mojaloop/central-services-shared/src/util/hash.js
  const hashSha256 = Crypto.createHash('sha256')
  let hash = JSON.stringify(object)
  hash = hashSha256.update(hash)
  // remove trailing '=' as per specification
  hash = hashSha256.digest(hash).toString('base64').slice(0, -1)
  return hash
}
// ### END: Placeholder for modifing Comparators.duplicateCheckComparator algorithm to use an insert only method for duplicate checking

const consumerCommit = false
const fromSwitch = true
const toDestination = true

const { performance } = require('perf_hooks')
const { SeriesTool } = require('../../lib/SeriesTool')
const timingsPrepare = new SeriesTool('prepare')


const timingsPrepareBeforeDuplicateCheck = new SeriesTool('prepare::duplicateCheck')
const timingsPrepareBeforeMainIf = new SeriesTool('prepare::beforeMainIf')
const timingsPrepareBeforeValidation = new SeriesTool('prepare::beforeValidation')
const timingsPrepareValidationPassed = new SeriesTool('prepare::validationPassed')
const timingsPrepareValidationPassedSent = new SeriesTool('prepare::validationPassedSent')
const timingsPrepareValidationBeforeKafka = new SeriesTool('prepare::beforeKafka')




/**
 * @function TransferPrepareHandler
 *
 * @async
 * @description This is the consumer callback function that gets registered to a topic. This then gets a list of messages,
 * we will only ever use the first message in non batch processing. We then break down the message into its payload and
 * begin validating the payload. Once the payload is validated successfully it will be written to the database to
 * the relevant tables. If the validation fails it is still written to the database for auditing purposes but with an
 * INVALID status. For any duplicate requests we will send appropriate callback based on the transfer state and the hash validation
 *
 * Validator.validateByName called to validate the payload of the message
 * TransferService.getById called to get the details of the existing transfer
 * TransferObjectTransform.toTransfer called to transform the transfer object
 * TransferService.prepare called and creates new entries in transfer tables for successful prepare transfer
 * TransferService.logTransferError called to log the invalid request
 *
 * @param {error} error - error thrown if something fails within Kafka
 * @param {array} messages - a list of messages to consume for the relevant topic
 *
 * @returns {object} - Returns a boolean: true if successful, or throws and error if failed
 */
const prepare = async (error, messages) => {
  const tick = performance.now()
  const location = { module: 'PrepareHandler', method: '', path: '' }
  const histTimerEnd = Metrics.getHistogram(
    'transfer_prepare',
    'Consume a prepare transfer message from the kafka topic and process it accordingly',
    ['success', 'fspId']
  ).startTimer()
  if (error) {
    histTimerEnd({ success: false, fspId: Config.INSTRUMENTATION_METRICS_LABELS.fspId })
    throw ErrorHandler.Factory.reformatFSPIOPError(error)
  }
  let message = {}
  if (Array.isArray(messages)) {
    message = messages[0]
  } else {
    message = messages
  }
  const parentSpanService = 'cl_transfer_prepare'
  const contextFromMessage = EventSdk.Tracer.extractContextFromMessage(message.value)
  const span = EventSdk.Tracer.createChildSpanFromContext(parentSpanService, contextFromMessage)
  try {
    const payload = decodePayload(message.value.content.payload)
    const headers = message.value.content.headers
    const action = message.value.metadata.event.action
    const transferId = payload.transferId
    span.setTags({ transactionId: transferId })
    await span.audit(message, EventSdk.AuditEventAction.start)
    const kafkaTopic = message.topic
    Logger.info(Util.breadcrumb(location, { method: 'prepare' }))

    const actionLetter = action === TransferEventAction.PREPARE ? Enum.Events.ActionLetter.prepare
      : (action === TransferEventAction.BULK_PREPARE ? Enum.Events.ActionLetter.bulkPrepare
        : Enum.Events.ActionLetter.unknown)

    let functionality = action === TransferEventAction.PREPARE ? TransferEventType.NOTIFICATION
      : (action === TransferEventAction.BULK_PREPARE ? TransferEventType.BULK_PROCESSING
        : Enum.Events.ActionLetter.unknown)
    const params = { message, kafkaTopic, decodedPayload: payload, span, consumer: Consumer, producer: Producer }

    Logger.info(Util.breadcrumb(location, { path: 'dupCheck' }))
    const histTimerDuplicateCheckEnd = Metrics.getHistogram(
      'handler_transfers',
      'prepare_duplicateCheckComparator - Metrics for transfer handler',
      ['success', 'funcName', 'mode']
    ).startTimer()

    timingsPrepareBeforeDuplicateCheck.addDatapoint(performance.now() - tick)

    // ### Following has been commented out to test the Insert only algorithm for duplicate-checks
    // const { hasDuplicateId, hasDuplicateHash } = await Comparators.duplicateCheckComparator(transferId, payload, TransferService.getTransferDuplicateCheck, TransferService.saveTransferDuplicateCheck)
    let { hasDuplicateId, hasDuplicateHash } = { hasDuplicateId: true, hasDuplicateHash: true } // lets assume the worst case
    let prepare_duplicateCheckComparator_mode = 'UNDEFINED'
    // Logger.warn(`PREPARE_ENABLED_DUPLCIATE_INSERT_ONLY=${PREPARE_ENABLED_DUPLCIATE_INSERT_ONLY}`)
    if (PREPARE_DUPLICATE_INSERT_MODE === 'INSERT_ONLY') {
      prepare_duplicateCheckComparator_mode = 'INSERT_ONLY'
      // Logger.warn(`PREPARE_ENABLED_DUPLCIATE_INSERT_ONLY=${PREPARE_ENABLED_DUPLCIATE_INSERT_ONLY} - YES`)
      // ### START: Placeholder for modifing Comparators.duplicateCheckComparator algorithm to use an insert only method for duplicate checking
      const generatedHash = generateSha256(payload) // modified from @mojaloop/central-services-shared/src/util/comparators/duplicateCheckComparator.js
      try {
        await TransferService.saveTransferDuplicateCheck(transferId, generatedHash) // modified from @mojaloop/central-services-shared/src/util/comparators/duplicateCheckComparator.js
        hasDuplicateId = false // overriding results to golden path successful use-case only for testing purposes
        hasDuplicateHash = false // overriding results to golden path successful use-case only for testing purposes
      } catch (err) {
        Logger.error(err)
        hasDuplicateId = true // overriding results to false in the advent there is any errors since we cant have duplicate transferIds
        hasDuplicateHash = false // overriding results to false in the advent there is any errors since we have not compared against any existing hashes
      }
      // ### END: Placeholder for modifing Comparators.duplicateCheckComparator algorithm to use an insert only method for duplicate checking
    } else if (PREPARE_DUPLICATE_INSERT_MODE === 'DISABLED') {
      prepare_duplicateCheckComparator_mode = 'DISABLED'
      hasDuplicateId = false // overriding results to false in the advent there is any errors since we cant have duplicate transferIds
      hasDuplicateHash = false // overriding results to false in the advent there is any errors since we have not compared against any existing hashes
    } else {
      prepare_duplicateCheckComparator_mode = 'DEFAULT'
      // Logger.warn(`PREPARE_ENABLED_DUPLCIATE_INSERT_ONLY=${PREPARE_ENABLED_DUPLCIATE_INSERT_ONLY} - NO`)
      // ### Following has been commented out to test the Insert only algorithm for duplicate-checks
      const { tempHasDuplicateId, tempHasDuplicateHash } = await Comparators.duplicateCheckComparator(transferId, payload, TransferService.getTransferDuplicateCheck, TransferService.saveTransferDuplicateCheck)
      hasDuplicateId = tempHasDuplicateId // overriding results to false in the advent there is any errors since we cant have duplicate transferIds
      hasDuplicateHash = tempHasDuplicateHash // overriding results to false in the advent there is any errors since we have not compared against any existing hashes
    }

    histTimerDuplicateCheckEnd({ success: true, funcName: 'prepare_duplicateCheckComparator', mode: prepare_duplicateCheckComparator_mode })
    if (hasDuplicateId && hasDuplicateHash) {
      Logger.info(Util.breadcrumb(location, 'handleResend'))
      const transfer = await TransferService.getByIdLight(transferId)
      const transferStateEnum = transfer && transfer.transferStateEnumeration
      const eventDetail = { functionality, action: TransferEventAction.PREPARE_DUPLICATE }
      if ([TransferState.COMMITTED, TransferState.ABORTED].includes(transferStateEnum)) {
        Logger.info(Util.breadcrumb(location, 'finalized'))
        if (action === TransferEventAction.PREPARE) {
          Logger.info(Util.breadcrumb(location, `callback--${actionLetter}1`))
          message.value.content.payload = TransferObjectTransform.toFulfil(transfer)
          message.value.content.uriParams = { id: transferId }
          if (PREPARE_SEND_POSITION_TO_KAFKA) {
            await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, eventDetail, fromSwitch })
          } else {
            await proceedToPosition(Config.KAFKA_CONFIG, params, { consumerCommit, eventDetail, fromSwitch })
          }
          histTimerEnd({ success: true, fspId: Config.INSTRUMENTATION_METRICS_LABELS.fspId })
          return true
        } else if (action === TransferEventAction.BULK_PREPARE) {
          Logger.info(Util.breadcrumb(location, `validationError1--${actionLetter}2`))
          const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.MODIFIED_REQUEST, 'Individual transfer prepare duplicate')
          if (PREPARE_SEND_POSITION_TO_KAFKA) {
            await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
          } else {
            await proceedToPosition(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
          }
          throw fspiopError
        }
      } else {
        Logger.info(Util.breadcrumb(location, 'inProgress'))
        if (action === TransferEventAction.BULK_PREPARE) {
          Logger.info(Util.breadcrumb(location, `validationError2--${actionLetter}4`))
          const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.MODIFIED_REQUEST, 'Individual transfer prepare duplicate')
          if (PREPARE_SEND_POSITION_TO_KAFKA) {
            await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
          } else {
            await proceedToPosition(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
          }
          throw fspiopError
        } else { // action === TransferEventAction.PREPARE
          Logger.info(Util.breadcrumb(location, `ignore--${actionLetter}3`))
          if (PREPARE_SEND_POSITION_TO_KAFKA) {
            await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit })
          } else {
            await proceedToPosition(Config.KAFKA_CONFIG, params, { consumerCommit })
          }
          histTimerEnd({ success: true, fspId: Config.INSTRUMENTATION_METRICS_LABELS.fspId })
          return true
        }
      }
    } else if (hasDuplicateId && !hasDuplicateHash) {
      Logger.error(Util.breadcrumb(location, `callbackErrorModified1--${actionLetter}5`))
      const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.MODIFIED_REQUEST)
      const eventDetail = { functionality, action }
      if (PREPARE_SEND_POSITION_TO_KAFKA) {
        await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
      } else {
        await proceedToPosition(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
      }
      throw fspiopError
    } else { // !hasDuplicateId
      timingsPrepareBeforeValidation.addDatapoint(performance.now() - tick)
      const { validationPassed, reasons } = await Validator.validateByName(payload, headers)
      if (validationPassed) {
        const tick2 = performance.now()


        Logger.info(Util.breadcrumb(location, { path: 'validationPassed' }))
        try {
          Logger.info(Util.breadcrumb(location, 'saveTransfer'))
          timingsPrepareValidationPassed.addDatapoint(performance.now() - tick)
          await TransferService.prepare(payload)
          timingsPrepareValidationPassedSent.addDatapoint(performance.now() - tick)
        } catch (err) {
          Logger.info(Util.breadcrumb(location, `callbackErrorInternal1--${actionLetter}6`))
          Logger.error(`${Util.breadcrumb(location)}::${err.message}`)
          const fspiopError = ErrorHandler.Factory.reformatFSPIOPError(err, ErrorHandler.Enums.FSPIOPErrorCodes.INTERNAL_SERVER_ERROR)
          const eventDetail = { functionality, action: TransferEventAction.PREPARE }
          /**
           * TODO: BULK-Handle at BulkProcessingHandler (not in scope of #967)
           * HOWTO: Stop execution at the `TransferService.prepare`, stop mysql,
           * continue execution to catch block, start mysql
           */
          if (PREPARE_SEND_POSITION_TO_KAFKA) {
            await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch }) /// <--- needs to be replaced with call to positionHandler            
          } else {
            await proceedToPosition(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
          }
          throw fspiopError
        }
        Logger.info(Util.breadcrumb(location, `positionTopic1--${actionLetter}7`))
        functionality = TransferEventType.POSITION
        const eventDetail = { functionality, action }
        if (PREPARE_SEND_POSITION_TO_KAFKA) {
          await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, eventDetail, toDestination })
        } else {
          await proceedToPosition(Config.KAFKA_CONFIG, params, { consumerCommit, eventDetail, toDestination })
        }
        histTimerEnd({ success: true, fspId: Config.INSTRUMENTATION_METRICS_LABELS.fspId })

        timingsPrepare.addDatapoint(performance.now() - tick)

        return true
      } else {
        Logger.error(Util.breadcrumb(location, { path: 'validationFailed' }))
        try {
          Logger.info(Util.breadcrumb(location, 'saveInvalidRequest'))
          await TransferService.prepare(payload, reasons.toString(), false)
        } catch (err) {
          Logger.info(Util.breadcrumb(location, `callbackErrorInternal2--${actionLetter}8`))
          Logger.error(`${Util.breadcrumb(location)}::${err.message}`)
          const fspiopError = ErrorHandler.Factory.reformatFSPIOPError(err, ErrorHandler.Enums.FSPIOPErrorCodes.INTERNAL_SERVER_ERROR)
          const eventDetail = { functionality, action: TransferEventAction.PREPARE }
          /**
           * TODO: BULK-Handle at BulkProcessingHandler (not in scope of #967)
           * HOWTO: For regular transfers this branch may be triggered by sending
           * a transfer in a currency not supported by either dfsp and also stopping
           * mysql at `TransferService.prepare` and starting it after entring catch.
           * Not sure if it will work for bulk, because of the BulkPrepareHandler.
           */
          if (PREPARE_SEND_POSITION_TO_KAFKA) {
            await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
          } else {
            await proceedToPosition(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
          }
          throw fspiopError
        }
        Logger.info(Util.breadcrumb(location, `callbackErrorGeneric--${actionLetter}9`))
        const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.VALIDATION_ERROR, reasons.toString())
        await TransferService.logTransferError(transferId, ErrorHandler.Enums.FSPIOPErrorCodes.VALIDATION_ERROR.code, reasons.toString())
        const eventDetail = { functionality, action }
        /**
         * TODO: BULK-Handle at BulkProcessingHandler (not in scope of #967)
         * HOWTO: For regular transfers this branch may be triggered by sending
         * a tansfer in a currency not supported by either dfsp. Not sure if it
         * will be triggered for bulk, because of the BulkPrepareHandler.
         */
        if (PREPARE_SEND_POSITION_TO_KAFKA) {
          await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
        } else {
          proceedToPosition(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
        }
        throw fspiopError
      }
    }
  } catch (err) {
    console.log('crash')

    histTimerEnd({ success: false, fspId: Config.INSTRUMENTATION_METRICS_LABELS.fspId })
    const fspiopError = ErrorHandler.Factory.reformatFSPIOPError(err)
    Logger.error(`${Util.breadcrumb(location)}::${err.message}--P0`)
    const state = new EventSdk.EventStateMetadata(EventSdk.EventStatusType.failed, fspiopError.apiErrorCode.code, fspiopError.apiErrorCode.message)
    await span.error(fspiopError, state)
    await span.finish(fspiopError.message, state)
    return true
  } finally {
    if (!span.isFinished) {
      await span.finish()
    }
  }
}

const fulfil = async (error, messages) => {
  const location = { module: 'FulfilHandler', method: '', path: '' }
  const histTimerEnd = Metrics.getHistogram(
    'transfer_fulfil',
    'Consume a fulfil transfer message from the kafka topic and process it accordingly',
    ['success', 'fspId']
  ).startTimer()
  if (error) {
    throw ErrorHandler.Factory.reformatFSPIOPError(error)
  }
  let message = {}
  if (Array.isArray(messages)) {
    message = messages[0]
  } else {
    message = messages
  }
  const contextFromMessage = EventSdk.Tracer.extractContextFromMessage(message.value)
  const span = EventSdk.Tracer.createChildSpanFromContext('cl_transfer_fulfil', contextFromMessage)
  try {
    await span.audit(message, EventSdk.AuditEventAction.start)
    const payload = decodePayload(message.value.content.payload)
    const headers = message.value.content.headers
    const type = message.value.metadata.event.type
    const action = message.value.metadata.event.action
    const transferId = message.value.content.uriParams.id
    const kafkaTopic = message.topic
    Logger.info(Util.breadcrumb(location, { method: `fulfil:${action}` }))

    const actionLetter = action === TransferEventAction.COMMIT ? Enum.Events.ActionLetter.commit
      : (action === TransferEventAction.REJECT ? Enum.Events.ActionLetter.reject
        : (action === TransferEventAction.ABORT ? Enum.Events.ActionLetter.abort
          : (action === TransferEventAction.BULK_COMMIT ? Enum.Events.ActionLetter.bulkCommit
            : Enum.Events.ActionLetter.unknown)))
    const functionality = action === TransferEventAction.COMMIT ? TransferEventType.NOTIFICATION
      : (action === TransferEventAction.REJECT ? TransferEventType.NOTIFICATION
        : (action === TransferEventAction.ABORT ? TransferEventType.NOTIFICATION
          : (action === TransferEventAction.BULK_COMMIT ? TransferEventType.BULK_PROCESSING
            : Enum.Events.ActionLetter.unknown)))
    // fulfil-specific declarations
    const isTransferError = action === TransferEventAction.ABORT
    const params = { message, kafkaTopic, decodedPayload: payload, span, consumer: Consumer, producer: Producer }

    Logger.info(Util.breadcrumb(location, { path: 'getById' }))
    const transfer = await TransferService.getById(transferId)
    const transferStateEnum = transfer && transfer.transferStateEnumeration

    if (!transfer) {
      Logger.error(Util.breadcrumb(location, `callbackInternalServerErrorNotFound--${actionLetter}1`))
      const fspiopError = ErrorHandler.Factory.createInternalServerFSPIOPError('transfer not found')
      const eventDetail = { functionality, action: TransferEventAction.COMMIT }
      /**
       * TODO: BULK-Handle at BulkProcessingHandler (not in scope of #967)
       * HOWTO: The list of individual transfers being committed should contain
       * non-existing transferId
       */
      await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
      throw fspiopError
    } else if (headers[Enum.Http.Headers.FSPIOP.SOURCE].toLowerCase() !== transfer.payeeFsp.toLowerCase()) {
      /**
       * If fulfilment request is coming from a source not matching transfer payee fsp,
       * don't proceed the request, but rather send error callback to original payee fsp.
       * This is also the reason why we need to retrieve the transfer info upfront now.
       */
      Logger.info(Util.breadcrumb(location, `callbackErrorSourceNotMatchingPayeeFsp--${actionLetter}2`))
      const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.VALIDATION_ERROR, `${Enum.Http.Headers.FSPIOP.SOURCE} does not match payee fsp`)
      const toDestination = transfer.payeeFsp // overrding global boolean declaration with a string value for local use only
      const eventDetail = { functionality, action: TransferEventAction.COMMIT }
      /**
       * TODO: BULK-Handle at BulkProcessingHandler (not in scope of #967)
       * HOWTO: For regular transfers, send the fulfil from non-payee dfsp.
       * Not sure if it will apply to bulk, as it could/should be captured
       * at BulkPrepareHander. To be verified as part of future story.
       */
      await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch, toDestination })
      throw fspiopError
    }
    // If execution continues after this point we are sure transfer exists and source matches payee fsp

    Logger.info(Util.breadcrumb(location, { path: 'dupCheck' }))

    Logger.info(Util.breadcrumb(location, { path: 'dupCheck' }))
    const histTimerDuplicateCheckEnd = Metrics.getHistogram(
      'handler_transfers',
      'fulfil_duplicateCheckComparator - Metrics for transfer handler',
      ['success', 'funcName', 'mode']
    ).startTimer()

    // ### Following has been commented out to test the Insert only algorithm for duplicate-checks
    // const { hasDuplicateId, hasDuplicateHash } = await Comparators.duplicateCheckComparator(transferId, payload, TransferService.getTransferDuplicateCheck, TransferService.saveTransferDuplicateCheck)
    let { hasDuplicateId, hasDuplicateHash } = { hasDuplicateId: true, hasDuplicateHash: true } // lets assume the worst case
    let fulfil_duplicateCheckComparator_mode = 'UNDEFINED'
    if (FULFIL_DUPLICATE_INSERT_MODE === 'INSERT_ONLY') {
      fulfil_duplicateCheckComparator_mode = 'INSERT_ONLY'
      // ### START: Placeholder for modifing Comparators.duplicateCheckComparator algorithm to use an insert only method for duplicate checking
      const generatedHash = generateSha256(payload) // modified from @mojaloop/central-services-shared/src/util/comparators/duplicateCheckComparator.js
      try {
        if (!isTransferError) {
          await TransferService.saveTransferFulfilmentDuplicateCheck(transferId, generatedHash) // modified from @mojaloop/central-services-shared/src/util/comparators/duplicateCheckComparator.js
        } else {
          await TransferService.saveTransferErrorDuplicateCheck(transferId, generatedHash) // modified from @mojaloop/central-services-shared/src/util/comparators/duplicateCheckComparator.js
        }
        hasDuplicateId = false // overriding results to golden path successful use-case only for testing purposes
        hasDuplicateHash = false // overriding results to golden path successful use-case only for testing purposes
      } catch (err) {
        Logger.error(err)
        hasDuplicateId = true // overriding results to false in the advent there is any errors since we cant have duplicate transferIds
        hasDuplicateHash = false // overriding results to false in the advent there is any errors since we have not compared against any existing hashes
      }
      // ### END: Placeholder for modifing Comparators.duplicateCheckComparator algorithm to use an insert only method for duplicate checking
    } else if (FULFIL_DUPLICATE_INSERT_MODE === 'DISABLED') {
      fulfil_duplicateCheckComparator_mode = 'DISABLED'
      hasDuplicateId = false // overriding results to false in the advent there is any errors since we cant have duplicate transferIds
      hasDuplicateHash = false // overriding results to false in the advent there is any errors since we have not compared against any existing hashes
    } else {
      fulfil_duplicateCheckComparator_mode = 'DEFAULT'
      let dupCheckResult
      if (!isTransferError) {
        dupCheckResult = await Comparators.duplicateCheckComparator(transferId, payload, TransferService.getTransferFulfilmentDuplicateCheck, TransferService.saveTransferFulfilmentDuplicateCheck)
      } else {
        dupCheckResult = await Comparators.duplicateCheckComparator(transferId, payload, TransferService.getTransferErrorDuplicateCheck, TransferService.saveTransferErrorDuplicateCheck)
      }
      hasDuplicateId = dupCheckResult.hasDuplicateId // overriding results to false in the advent there is any errors since we cant have duplicate transferIds
      hasDuplicateHash = dupCheckResult.hasDuplicateHash // overriding results to false in the advent there is any errors since we have not compared against any existing hashes
    }
  
    // let dupCheckResult
    // if (!isTransferError) {
    //   dupCheckResult = await Comparators.duplicateCheckComparator(transferId, payload, TransferService.getTransferFulfilmentDuplicateCheck, TransferService.saveTransferFulfilmentDuplicateCheck)
    // } else {
    //   dupCheckResult = await Comparators.duplicateCheckComparator(transferId, payload, TransferService.getTransferErrorDuplicateCheck, TransferService.saveTransferErrorDuplicateCheck)
    // }
    // const { hasDuplicateId, hasDuplicateHash } = dupCheckResult

    histTimerDuplicateCheckEnd({ success: true, funcName: 'fulfil_duplicateCheckComparator', mode: fulfil_duplicateCheckComparator_mode })

    if (hasDuplicateId && hasDuplicateHash) {
      Logger.info(Util.breadcrumb(location, 'handleResend'))
      if (transferStateEnum === TransferState.COMMITTED || transferStateEnum === TransferState.ABORTED) {
        message.value.content.payload = TransferObjectTransform.toFulfil(transfer)
        if (!isTransferError) {
          Logger.info(Util.breadcrumb(location, `callbackFinilized2--${actionLetter}3`))
          const eventDetail = { functionality, action: TransferEventAction.FULFIL_DUPLICATE }
          /**
           * HOWTO: During bulk fulfil use an individualTransfer from a previous bulk fulfil
           */
          await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, eventDetail, fromSwitch })
          histTimerEnd({ success: true, fspId: Config.INSTRUMENTATION_METRICS_LABELS.fspId })
          return true
        } else {
          Logger.info(Util.breadcrumb(location, `callbackFinilized3--${actionLetter}4`))
          const eventDetail = { functionality, action: TransferEventAction.ABORT_DUPLICATE }
          await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, eventDetail, fromSwitch })
          histTimerEnd({ success: true, fspId: Config.INSTRUMENTATION_METRICS_LABELS.fspId })
          return true
        }
      } else if (transferStateEnum === TransferState.RECEIVED || transferStateEnum === TransferState.RESERVED) {
        Logger.info(Util.breadcrumb(location, `inProgress2--${actionLetter}5`))
        /**
         * HOWTO: Nearly impossible to trigger for bulk - an individual transfer from a bulk needs to be triggered
         * for processing in order to have the fulfil duplicate hash recorded. While it is still in RESERVED state
         * the individual transfer needs to be requested by another bulk fulfil request!
         *
         * TODO: find a way to trigger this code branch and handle it at BulkProcessingHandler (not in scope of #967)
         */
        await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, histTimerEnd })
        histTimerEnd({ success: true, fspId: Config.INSTRUMENTATION_METRICS_LABELS.fspId })
        return true
      } else {
        Logger.info(Util.breadcrumb(location, `callbackErrorInvalidTransferStateEnum--${actionLetter}6`))
        const fspiopError = ErrorHandler.Factory.createInternalServerFSPIOPError(
          `Invalid transferStateEnumeration:(${transferStateEnum}) for event action:(${action}) and type:(${type})`).toApiErrorObject(Config.ERROR_HANDLING)
        const eventDetail = { functionality, action: TransferEventAction.COMMIT }
        /**
         * HOWTO: Impossible to trigger for individual transfer in a bulk? (not in scope of #967)
         */
        await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError, eventDetail, fromSwitch })
        histTimerEnd({ success: true, fspId: Config.INSTRUMENTATION_METRICS_LABELS.fspId })
        return true
      }
    } else if (hasDuplicateId && !hasDuplicateHash) {
      let eventDetail
      const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.MODIFIED_REQUEST)
      if (!isTransferError) {
        Logger.info(Util.breadcrumb(location, `callbackErrorModified2--${actionLetter}7`))
        eventDetail = { functionality, action: TransferEventAction.FULFIL_DUPLICATE }
        /**
         * HOWTO: During bulk fulfil use an individualTransfer from a previous bulk fulfil,
         * but use different fulfilment value.
         */
      } else {
        Logger.info(Util.breadcrumb(location, `callbackErrorModified3--${actionLetter}8`))
        eventDetail = { functionality, action: TransferEventAction.ABORT_DUPLICATE }
      }
      await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
      throw fspiopError
    } else { // !hasDuplicateId
      if (type === TransferEventType.FULFIL && [TransferEventAction.COMMIT, TransferEventAction.REJECT, TransferEventAction.ABORT, TransferEventAction.BULK_COMMIT].includes(action)) {
        Util.breadcrumb(location, { path: 'validationCheck' })
        if (payload.fulfilment && !Validator.validateFulfilCondition(payload.fulfilment, transfer.condition)) {
          Logger.info(Util.breadcrumb(location, `callbackErrorInvalidFulfilment--${actionLetter}9`))
          const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.VALIDATION_ERROR, 'invalid fulfilment')
          const apiFspiopError = fspiopError.toApiErrorObject(Config.ERROR_HANDLING)
          await TransferService.handlePayeeResponse(transferId, payload, action, apiFspiopError)
          const eventDetail = { functionality: TransferEventType.POSITION, action: TransferEventAction.ABORT }
          /**
           * TODO: BulkProcessingHandler (not in scope of #967) The individual transfer is ABORTED by notification is never sent.
           */
          await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: apiFspiopError, eventDetail, toDestination })
          throw fspiopError
        } else if (transfer.transferState !== TransferState.RESERVED) {
          Logger.info(Util.breadcrumb(location, `callbackErrorNonReservedState--${actionLetter}10`))
          const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.VALIDATION_ERROR, 'non-RESERVED transfer state')
          const eventDetail = { functionality, action: TransferEventAction.COMMIT }
          /**
           * TODO: BulkProcessingHandler (not in scope of #967)
           */
          await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
          throw fspiopError
        } else if (transfer.expirationDate <= new Date(Util.Time.getUTCString(new Date()))) {
          Logger.info(Util.breadcrumb(location, `callbackErrorTransferExpired--${actionLetter}11`))
          const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.TRANSFER_EXPIRED)
          const eventDetail = { functionality, action: TransferEventAction.COMMIT }
          /**
           * TODO: BulkProcessingHandler (not in scope of #967)
           */
          await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
          throw fspiopError
        } else { // validations success
          Logger.info(Util.breadcrumb(location, { path: 'validationPassed' }))
          if ([TransferEventAction.COMMIT, TransferEventAction.BULK_COMMIT].includes(action)) {
            Logger.info(Util.breadcrumb(location, `positionTopic2--${actionLetter}12`))
            await TransferService.handlePayeeResponse(transferId, payload, action)
            const eventDetail = { functionality: TransferEventType.POSITION, action }
            await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, eventDetail, toDestination })
            histTimerEnd({ success: true, fspId: Config.INSTRUMENTATION_METRICS_LABELS.fspId })
            return true
          } else {
            if (action === TransferEventAction.REJECT) {
              Logger.info(Util.breadcrumb(location, `positionTopic3--${actionLetter}13`))
              await TransferService.handlePayeeResponse(transferId, payload, action)
              const eventDetail = { functionality: TransferEventType.POSITION, action: TransferEventAction.REJECT }
              await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, eventDetail, toDestination })
              histTimerEnd({ success: true, fspId: Config.INSTRUMENTATION_METRICS_LABELS.fspId })
              return true
            } else { // action === TransferEventAction.ABORT // error-callback request to be processed
              Logger.info(Util.breadcrumb(location, `positionTopic4--${actionLetter}14`))
              let fspiopError
              const eInfo = payload.errorInformation
              try { // handle only valid errorCodes provided by the payee
                fspiopError = ErrorHandler.Factory.createFSPIOPErrorFromErrorInformation(eInfo)
              } catch (err) {
                /**
                 * TODO: Handling of out-of-range errorCodes is to be introduced to the ml-api-adapter,
                 * so that such requests are rejected right away, instead of aborting the transfer here.
                 */
                fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.VALIDATION_ERROR, 'API specification undefined errorCode')
                await TransferService.handlePayeeResponse(transferId, payload, action, fspiopError.toApiErrorObject(Config.ERROR_HANDLING))
                const eventDetail = { functionality: TransferEventType.POSITION, action: TransferEventAction.ABORT }
                await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, toDestination })
                throw fspiopError
              }
              await TransferService.handlePayeeResponse(transferId, payload, action, fspiopError.toApiErrorObject(Config.ERROR_HANDLING))
              const eventDetail = { functionality: TransferEventType.POSITION, action: TransferEventAction.ABORT }
              await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, toDestination })
              throw fspiopError
            }
          }
        }
      } else {
        Logger.info(Util.breadcrumb(location, `callbackErrorInvalidEventAction--${actionLetter}15`))
        const fspiopError = ErrorHandler.Factory.createInternalServerFSPIOPError(`Invalid event action:(${action}) and/or type:(${type})`)
        const eventDetail = { functionality, action: TransferEventAction.COMMIT }
        /**
         * TODO: BulkProcessingHandler (not in scope of #967)
         */
        await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
        throw fspiopError
      }
    }
  } catch (err) {
    histTimerEnd({ success: false, fspId: Config.INSTRUMENTATION_METRICS_LABELS.fspId })
    const fspiopError = ErrorHandler.Factory.reformatFSPIOPError(err)
    Logger.error(`${Util.breadcrumb(location)}::${err.message}--F0`)
    const state = new EventSdk.EventStateMetadata(EventSdk.EventStatusType.failed, fspiopError.apiErrorCode.code, fspiopError.apiErrorCode.message)
    await span.error(fspiopError, state)
    await span.finish(fspiopError.message, state)
    return true
  } finally {
    if (!span.isFinished) {
      await span.finish()
    }
  }
}

/**
 * @function getTransfer
 *
 * @async
 * @description Gets a transfer by transfer id. Gets Kafka config from default.json
 *
 * Calls createHandler to register the handler against the Stream Processing API
 * @returns {boolean} - Returns a boolean: true if successful, or throws and error if failed
 */
const getTransfer = async (error, messages) => {
  const location = { module: 'GetTransferHandler', method: '', path: '' }
  const histTimerEnd = Metrics.getHistogram(
    'transfer_get',
    'Consume a get transfer message from the kafka topic and process it accordingly',
    ['success', 'fspId']
  ).startTimer()
  if (error) {
    throw ErrorHandler.Factory.reformatFSPIOPError(error)
  }
  let message = {}
  if (Array.isArray(messages)) {
    message = messages[0]
  } else {
    message = messages
  }
  const contextFromMessage = EventSdk.Tracer.extractContextFromMessage(message.value)
  const span = EventSdk.Tracer.createChildSpanFromContext('cl_transfer_get', contextFromMessage)
  try {
    await span.audit(message, EventSdk.AuditEventAction.start)
    const metadata = message.value.metadata
    const action = metadata.event.action
    const transferId = message.value.content.uriParams.id
    const kafkaTopic = message.topic
    Logger.info(Util.breadcrumb(location, { method: `getTransfer:${action}` }))

    const actionLetter = Enum.Events.ActionLetter.get
    const params = { message, kafkaTopic, span, consumer: Consumer, producer: Producer }
    const eventDetail = { functionality: TransferEventType.NOTIFICATION, action: TransferEventAction.GET }

    Util.breadcrumb(location, { path: 'validationFailed' })
    if (!await Validator.validateParticipantByName(message.value.from)) {
      Logger.info(Util.breadcrumb(location, `breakParticipantDoesntExist--${actionLetter}1`))
      await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, histTimerEnd })
      histTimerEnd({ success: true, fspId: Config.INSTRUMENTATION_METRICS_LABELS.fspId })
      return true
    }
    const transfer = await TransferService.getByIdLight(transferId)
    if (!transfer) {
      Logger.info(Util.breadcrumb(location, `callbackErrorTransferNotFound--${actionLetter}3`))
      const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.TRANSFER_ID_NOT_FOUND, 'Provided Transfer ID was not found on the server.')
      await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
      throw fspiopError
    }
    if (!await Validator.validateParticipantTransferId(message.value.from, transferId)) {
      Logger.info(Util.breadcrumb(location, `callbackErrorNotTransferParticipant--${actionLetter}2`))
      const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.CLIENT_ERROR)
      await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, fspiopError: fspiopError.toApiErrorObject(Config.ERROR_HANDLING), eventDetail, fromSwitch })
      throw fspiopError
    }
    // ============================================================================================
    Util.breadcrumb(location, { path: 'validationPassed' })
    Logger.info(Util.breadcrumb(location, `callbackMessage--${actionLetter}4`))
    message.value.content.payload = TransferObjectTransform.toFulfil(transfer)
    await Kafka.proceed(Config.KAFKA_CONFIG, params, { consumerCommit, eventDetail, fromSwitch })
    histTimerEnd({ success: true, fspId: Config.INSTRUMENTATION_METRICS_LABELS.fspId })
    return true
  } catch (err) {
    histTimerEnd({ success: false, fspId: Config.INSTRUMENTATION_METRICS_LABELS.fspId })
    const fspiopError = ErrorHandler.Factory.reformatFSPIOPError(err)
    Logger.error(`${Util.breadcrumb(location)}::${err.message}--G0`)
    const state = new EventSdk.EventStateMetadata(EventSdk.EventStatusType.failed, fspiopError.apiErrorCode.code, fspiopError.apiErrorCode.message)
    await span.error(fspiopError, state)
    await span.finish(fspiopError.message, state)
    return true
  } finally {
    if (!span.isFinished) {
      await span.finish()
    }
  }
}

/**
 * @function registerPrepareHandler
 *
 * @async
 * @description Registers the handler for prepare topic. Gets Kafka config from default.json
 *
 * @returns {boolean} - Returns a boolean: true if successful, or throws and error if failed
 */
const registerPrepareHandler = async () => {
  try {
    const prepareHandler = {
      command: prepare,
      topicName: Kafka.transformGeneralTopicName(Config.KAFKA_CONFIG.TOPIC_TEMPLATES.GENERAL_TOPIC_TEMPLATE.TEMPLATE, TransferEventType.TRANSFER, TransferEventAction.PREPARE),
      config: Kafka.getKafkaConfig(Config.KAFKA_CONFIG, Enum.Kafka.Config.CONSUMER, TransferEventType.TRANSFER.toUpperCase(), TransferEventAction.PREPARE.toUpperCase())
    }
    prepareHandler.config.rdkafkaConf['client.id'] = prepareHandler.topicName
    await Consumer.createHandler(prepareHandler.topicName, prepareHandler.config, prepareHandler.command)
    return true
  } catch (err) {
    throw ErrorHandler.Factory.reformatFSPIOPError(err)
  }
}

/**
 * @function registerFulfilHandler
 *
 * @async
 * @description Registers the one handler for fulfil transfer. Gets Kafka config from default.json
 * Calls createHandler to register the handler against the Stream Processing API
 * @returns {boolean} - Returns a boolean: true if successful, or throws and error if failed
 */
const registerFulfilHandler = async () => {
  try {
    const fulfillHandler = {
      command: fulfil,
      topicName: Kafka.transformGeneralTopicName(Config.KAFKA_CONFIG.TOPIC_TEMPLATES.GENERAL_TOPIC_TEMPLATE.TEMPLATE, TransferEventType.TRANSFER, TransferEventType.FULFIL),
      config: Kafka.getKafkaConfig(Config.KAFKA_CONFIG, Enum.Kafka.Config.CONSUMER, TransferEventType.TRANSFER.toUpperCase(), TransferEventType.FULFIL.toUpperCase())
    }
    fulfillHandler.config.rdkafkaConf['client.id'] = fulfillHandler.topicName
    await Consumer.createHandler(fulfillHandler.topicName, fulfillHandler.config, fulfillHandler.command)
    return true
  } catch (err) {
    throw ErrorHandler.Factory.reformatFSPIOPError(err)
  }
}

/**
 * @function registerGetTransferHandler
 *
 * @async
 * @description Registers the one handler for get a transfer by Id. Gets Kafka config from default.json
 * Calls createHandler to register the handler against the Stream Processing API
 * @returns {boolean} - Returns a boolean: true if successful, or throws and error if failed
 */
const registerGetTransferHandler = async () => {
  try {
    const getHandler = {
      command: getTransfer,
      topicName: Kafka.transformGeneralTopicName(Config.KAFKA_CONFIG.TOPIC_TEMPLATES.GENERAL_TOPIC_TEMPLATE.TEMPLATE, TransferEventType.TRANSFER, TransferEventType.GET),
      config: Kafka.getKafkaConfig(Config.KAFKA_CONFIG, Enum.Kafka.Config.CONSUMER, TransferEventType.TRANSFER.toUpperCase(), TransferEventType.GET.toUpperCase())
    }
    getHandler.config.rdkafkaConf['client.id'] = getHandler.topicName
    await Consumer.createHandler(getHandler.topicName, getHandler.config, getHandler.command)
    return true
  } catch (err) {
    throw ErrorHandler.Factory.reformatFSPIOPError(err)
  }
}

/**
 * @function RegisterAllHandlers
 *
 * @async
 * @description Registers all handlers in transfers ie: prepare, fulfil, transfer and reject
 *
 * @returns {boolean} - Returns a boolean: true if successful, or throws and error if failed
 */
const registerAllHandlers = async () => {
  try {
    await registerPrepareHandler()
    await registerFulfilHandler()
    await registerGetTransferHandler()
    return true
  } catch (err) {
    throw ErrorHandler.Factory.reformatFSPIOPError(err)
  }
}

module.exports = {
  prepare,
  fulfil,
  getTransfer,
  registerPrepareHandler,
  registerFulfilHandler,
  registerGetTransferHandler,
  registerAllHandlers
}
