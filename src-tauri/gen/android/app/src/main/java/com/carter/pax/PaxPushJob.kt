package com.carter.pax

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.android.gms.tasks.Tasks
import com.google.firebase.messaging.FirebaseMessaging
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class PaxPushJob : JobService() {
    companion object {
        private const val JOB_ID = 745200
        private const val TAG = "PaxPush"
        private val executor = Executors.newSingleThreadExecutor()

        fun schedule(context: Context, replacePending: Boolean = false) {
            if (!PaxMessageNotifications.pushRegistrationActive(context)) return
            val scheduler = context.getSystemService(JobScheduler::class.java)
            if (!replacePending && scheduler.getPendingJob(JOB_ID) != null) return
            val job = JobInfo.Builder(JOB_ID, ComponentName(context, PaxPushJob::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setBackoffCriteria(30_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                .build()
            if (scheduler.schedule(job) != JobScheduler.RESULT_SUCCESS) {
                Log.w(TAG, "Could not schedule Matrix push registration")
            }
        }

        fun cancel(context: Context) {
            context.getSystemService(JobScheduler::class.java).cancel(JOB_ID)
        }
    }

    private val main = Handler(Looper.getMainLooper())
    @Volatile private var running: JobParameters? = null

    override fun onStartJob(params: JobParameters): Boolean {
        running = params
        executor.execute {
            val retry = if (running === params && PaxMessageNotifications.pushRegistrationActive(this)) {
                runCatching {
                    val token = currentToken()
                    if (running !== params || !PaxMessageNotifications.pushRegistrationActive(this)) false
                    else {
                        System.loadLibrary("pax_lib")
                        reconcile(applicationInfo.dataDir, token)
                    }
                }.getOrElse {
                    Log.w(TAG, "Could not initialize Matrix push registration", it)
                    true
                }
            } else false
            main.post {
                if (running === params) {
                    running = null
                    jobFinished(params, retry)
                }
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        if (running === params) running = null
        return PaxMessageNotifications.pushRegistrationActive(this)
    }

    private fun currentToken(): String {
        val prefs = getSharedPreferences(PaxFCMService.PREFS_NAME, Context.MODE_PRIVATE)
        val key = PaxFCMService.PREF_FCM_TOKEN
        return prefs.getString(key, null) ?: run {
            val token = Tasks.await(FirebaseMessaging.getInstance().token, 10, TimeUnit.SECONDS)
            // onNewToken may already have stored the latest token.
            prefs.getString(key, token) ?: token
        }
    }

    private external fun reconcile(dataDir: String, token: String): Boolean
}
